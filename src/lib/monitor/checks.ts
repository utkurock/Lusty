import { Horizon } from '@stellar/stellar-sdk'
import { getPool, ensureSchema } from '@/lib/db'
import {
  XLM,
  enabledUnderlyings,
  settleableUnderlyings,
  type UnderlyingAsset,
} from '@/lib/assets'
import { scanForSettlement, positionKey } from '@/lib/settlement'
import { computeOpenBuckets, callEpochCap } from '@/lib/vault-state'
import { getVaultStats } from '@/lib/vault-contract'
import { LUSD_DISTRIBUTOR } from '@/lib/lusd'
import type { Alert } from './notify'

/**
 * Risk-monitoring checks (P1-7). Each check is independent and best-effort:
 * a check that itself fails turns into a `critical` alert (we'd rather be
 * paged about a blind monitor than silently stop watching). Returns the list
 * of alerts that should fire this run — empty means all-clear.
 */

const HORIZON =
  process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org'

// Cap utilization at/above this percent fires a warning; at/above 100 a
// critical. Horizon/DB latency above the budget fires a warning.
const CAP_WARN_PCT = Number(process.env.MONITOR_CAP_WARN_PCT ?? 90)
const LATENCY_BUDGET_MS = Number(process.env.MONITOR_LATENCY_BUDGET_MS ?? 4000)
// Short-window realized vol this many times the 24h baseline → warning.
// Default 2× per the SCF risk-management follow-up.
const VOL_SPIKE_MULT = Number(process.env.MONITOR_VOL_SPIKE_MULT ?? 2)

async function checkHorizon(): Promise<Alert | null> {
  const t0 = Date.now()
  try {
    const server = new Horizon.Server(HORIZON)
    if (LUSD_DISTRIBUTOR) {
      await server.loadAccount(LUSD_DISTRIBUTOR)
    } else {
      await server.fetchBaseFee()
    }
    const ms = Date.now() - t0
    if (ms > LATENCY_BUDGET_MS) {
      return {
        severity: 'warning',
        title: 'Horizon slow',
        message: `Horizon responded in ${ms}ms, above the ${LATENCY_BUDGET_MS}ms budget. Deposits fail closed if it degrades further.`,
        fields: [{ label: 'latency_ms', value: String(ms) }],
      }
    }
    return null
  } catch (e: any) {
    return {
      severity: 'critical',
      title: 'Horizon unreachable',
      message: `Horizon ping failed: ${e?.message ?? 'unknown'}. Deposits and claims will fail closed.`,
      fields: [{ label: 'horizon', value: HORIZON }],
    }
  }
}

async function checkDb(): Promise<Alert | null> {
  const t0 = Date.now()
  try {
    await ensureSchema()
    await getPool().query('select 1')
    const ms = Date.now() - t0
    if (ms > LATENCY_BUDGET_MS) {
      return {
        severity: 'warning',
        title: 'Database slow',
        message: `DB responded in ${ms}ms, above the ${LATENCY_BUDGET_MS}ms budget.`,
        fields: [{ label: 'latency_ms', value: String(ms) }],
      }
    }
    return null
  } catch (e: any) {
    return {
      severity: 'critical',
      title: 'Database unreachable',
      message: `DB ping failed: ${e?.message ?? 'unknown'}. Cap checks fail closed, so deposits will be rejected.`,
    }
  }
}

// Every per-asset check names its asset in the title. Two books filling at
// different rates produce two alerts, and an alert that does not say which one
// is a page nobody can act on.
async function checkCapBreach(asset: UnderlyingAsset): Promise<Alert | null> {
  const unit = asset.symbol
  try {
    const buckets = await computeOpenBuckets(new Date(), asset)
    const epochCap = callEpochCap(asset)
    const combined = buckets.reduce((a, b) => a + b.callXlm, 0)
    const combinedCap = epochCap * Math.max(1, buckets.length)
    const pct = combinedCap > 0 ? (combined / combinedCap) * 100 : 0
    const fullExpiries = buckets.filter((b) => b.callXlm >= epochCap).length
    const fields = [
      { label: 'underlying', value: unit },
      { label: 'open_call', value: `${combined.toFixed(asset.displayDecimals)} ${unit}` },
      { label: 'cap', value: `${combinedCap.toFixed(asset.displayDecimals)} ${unit}` },
      { label: 'utilization_pct', value: pct.toFixed(2) },
      { label: 'full_expiries', value: `${fullExpiries}/${buckets.length}` },
    ]
    if (fullExpiries >= buckets.length && buckets.length > 0) {
      return {
        severity: 'critical',
        title: `${unit}: all covered-call epochs full`,
        message: `Every open ${unit} covered-call expiry is full (${fullExpiries}/${buckets.length}). New ${unit} call deposits are being rejected until an expiry rolls off.`,
        fields,
      }
    }
    if (pct >= CAP_WARN_PCT) {
      return {
        severity: 'warning',
        title: `${unit}: vault filling up`,
        message: `The ${unit} covered-call book is at ${pct.toFixed(1)}% of cap (warn at ${CAP_WARN_PCT}%).`,
        fields,
      }
    }
    return null
  } catch (e: any) {
    return {
      severity: 'critical',
      title: `${unit}: cap check blind`,
      message: `Could not compute ${unit} expiry buckets: ${e?.message ?? 'unknown'}. Utilization is unknown.`,
    }
  }
}

/**
 * The contract's own solvency guard, read from outside.
 *
 * `require_solvent` refuses a write unless every open position of a kind can
 * be paid out of the pool its payouts draw on — and that pool's token is also
 * the OTHER kind's collateral, held for its writers and not lendable. So the
 * test is `balance − escrowed(opposite) ≥ owed(kind)`, mirrored here exactly.
 *
 * Watching it from outside matters because the contract only checks at write
 * time. Between writes a pool can be drained by settlements and nothing on
 * chain will say so until the next deposit is refused — by which point the
 * refusal is the first anyone hears of it.
 */
async function checkSolvency(asset: UnderlyingAsset): Promise<Alert | null> {
  const unit = asset.symbol
  try {
    const s = await getVaultStats(asset)
    const legs = [
      {
        kind: 'call',
        // Calls pay cash; puts escrow cash.
        free: s.cashBalance - s.escrowedPut,
        owed: s.owedCall,
        token: 'LUSD',
      },
      {
        kind: 'put',
        // Puts pay the underlying; calls escrow the underlying.
        free: s.underlyingBalance - s.escrowedCall,
        owed: s.owedPut,
        token: unit,
      },
    ]
    const short = legs.filter((l) => l.free < l.owed)
    if (short.length === 0) return null

    return {
      severity: 'critical',
      title: `${unit}: vault cannot cover what it owes`,
      message:
        `The ${unit} instance is short on ${short.map((l) => l.kind).join(' and ')}. ` +
        `Its own guard will refuse new writes on that leg, and an assignment it ` +
        `cannot pay is a position that fails to settle. Fund the pool.`,
      fields: [
        { label: 'underlying', value: unit },
        ...short.map((l) => ({
          label: `${l.kind}_shortfall_${l.token}`,
          value: (l.owed - l.free).toFixed(7),
        })),
      ],
    }
  } catch (e: any) {
    return {
      severity: 'critical',
      title: `${unit}: solvency check blind`,
      message: `Could not read the ${unit} vault's totals: ${e?.message ?? 'unknown'}. Whether it can cover its obligations is unknown.`,
    }
  }
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const variance =
    xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)
  return Math.sqrt(variance)
}

function logReturns(closes: number[]): number[] {
  const r: number[] = []
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) {
      r.push(Math.log(closes[i] / closes[i - 1]))
    }
  }
  return r
}

export async function fetchCloses(
  interval: string,
  limit: number,
  asset: UnderlyingAsset = XLM,
): Promise<number[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${asset.binanceSymbol}&interval=${interval}&limit=${limit}`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`binance klines ${res.status}`)
  const rows = (await res.json()) as unknown[]
  // kline tuple: [openTime, open, high, low, close, ...]; close is index 4.
  return rows
    .map((row) => parseFloat((row as string[])[4]))
    .filter((n) => isFinite(n) && n > 0)
}

/**
 * Ratio of short-window (last ~1h) annualized realized vol to the 24h
 * baseline. Shared by the vol-spike alert and the auto-halt trigger so both
 * read the same number. Returns null if there isn't enough data.
 */
export async function computeVolRatio(
  asset: UnderlyingAsset = XLM,
): Promise<number | null> {
  // Short window: 60×1m ≈ last hour. Baseline: 24×1h ≈ last day.
  const [shortCloses, baseCloses] = await Promise.all([
    fetchCloses('1m', 60, asset),
    fetchCloses('1h', 24, asset),
  ])
  const shortRet = logReturns(shortCloses)
  const baseRet = logReturns(baseCloses)
  if (shortRet.length < 10 || baseRet.length < 10) return null

  // Annualize both so the ratio compares like with like.
  const MIN_PER_YEAR = 525_600
  const HOURS_PER_YEAR = 8_760
  const shortVol = stdev(shortRet) * Math.sqrt(MIN_PER_YEAR)
  const baseVol = stdev(baseRet) * Math.sqrt(HOURS_PER_YEAR)
  if (baseVol <= 0) return null
  return shortVol / baseVol
}

async function checkVolSpike(asset: UnderlyingAsset): Promise<Alert | null> {
  const unit = asset.symbol
  try {
    const ratio = await computeVolRatio(asset)
    if (ratio === null) return null
    if (ratio >= VOL_SPIKE_MULT) {
      return {
        severity: 'warning',
        title: `${unit} volatility spike`,
        message: `${unit}'s 1h realized vol is ${ratio.toFixed(2)}× its own 24h baseline (threshold ${VOL_SPIKE_MULT}×). Consider tightening ${unit}'s caps or halting deposits.`,
        fields: [
          { label: 'underlying', value: unit },
          { label: 'vol_ratio', value: ratio.toFixed(2) },
          { label: 'warn_threshold', value: `${VOL_SPIKE_MULT}x` },
        ],
      }
    }
    return null
  } catch (e: any) {
    // A flaky price feed shouldn't page anyone — info only.
    return {
      severity: 'info',
      title: `${unit} vol check skipped`,
      message: `Could not evaluate ${unit} volatility: ${e?.message ?? 'unknown'}.`,
    }
  }
}

/**
 * Is anything expired and still open?
 *
 * The check that was missing. Settlement is time-limited: past roughly a day
 * after expiry the oracle no longer has the price, the contract refuses, and
 * the collateral is escrowed with nothing able to release it. Nine positions
 * reached that state over three weeks without a single alert, because nothing
 * here was looking.
 *
 * Two severities, because they ask for opposite responses. A position that is
 * expired but still inside the window means the sweep is late — fix the sweep.
 * A position past the window means the sweep is already too late — that
 * collateral needs a decision, and no amount of retrying will produce one.
 */
async function checkSettlementBacklog(asset: UnderlyingAsset): Promise<Alert | null> {
  const unit = asset.symbol
  try {
    const scan = await scanForSettlement({ asset })
    if (scan.candidates.length === 0) return null

    const stranded = scan.pastDeadline
    const pending = scan.candidates.filter((c) => !c.pastDeadline)

    if (stranded.length > 0) {
      return {
        severity: 'critical',
        title: `${unit}: collateral stranded — settlement missed its window`,
        message:
          `${stranded.length} expired ${unit} position(s) are past the oracle's history window. ` +
          `The contract can no longer price them, there is no admin path to release escrow, ` +
          `and their collateral is locked permanently. ` +
          `${stranded.map((id) => positionKey(unit, id)).join(', ')}.`,
        fields: [
          { label: 'underlying', value: unit },
          { label: 'stranded', value: String(stranded.length) },
          { label: 'also_due', value: String(pending.length) },
        ],
      }
    }

    const soonest = pending.reduce(
      (min, c) => Math.min(min, c.settleBy.getTime()),
      Infinity
    )
    const hoursLeft = Math.max(0, (soonest - Date.now()) / 3_600_000)

    return {
      severity: 'warning',
      title: `${unit}: settlement sweep is behind`,
      message:
        `${pending.length} ${unit} position(s) have expired and are not settled. ` +
        `The earliest becomes unsettleable in ${hoursLeft.toFixed(1)}h, after which its ` +
        `collateral is locked for good.`,
      fields: [
        { label: 'underlying', value: unit },
        { label: 'due', value: String(pending.length) },
        { label: 'hours_to_deadline', value: hoursLeft.toFixed(1) },
      ],
    }
  } catch (e: any) {
    return {
      severity: 'critical',
      title: `${unit}: settlement scan failed`,
      message: `Could not read the ${unit} vault's positions: ${e?.message ?? 'unknown'}. Whether anything is due to settle is unknown.`,
    }
  }
}

/**
 * Run every check. Order-independent; failures inside a check are converted to
 * alerts by the check itself, so this never throws.
 */
export async function runMonitorChecks(): Promise<Alert[]> {
  // Caps and vol are about writing, so they follow the books being written.
  // Settlement and solvency follow every book with a vault: an asset withdrawn
  // from quoting still owes its open positions their collateral.
  const written = enabledUnderlyings()
  const held = settleableUnderlyings()

  const settled = await Promise.all([
    checkHorizon(),
    checkDb(),
    ...written.map((a) => checkCapBreach(a)),
    ...written.map((a) => checkVolSpike(a)),
    ...held.map((a) => checkSolvency(a)),
    ...held.map((a) => checkSettlementBacklog(a)),
  ])
  return settled.filter((a): a is Alert => a !== null)
}
