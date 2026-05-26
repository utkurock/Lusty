import { Horizon } from '@stellar/stellar-sdk'
import { getPool, ensureSchema } from '@/lib/db'
import { computeOpenExposure } from '@/lib/vault-state'
import type { Alert } from './notify'

/**
 * Risk-monitoring checks (P1-7). Each check is independent and best-effort:
 * a check that itself fails turns into a `critical` alert (we'd rather be
 * paged about a blind monitor than silently stop watching). Returns the list
 * of alerts that should fire this run — empty means all-clear.
 */

const HORIZON =
  process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org'
const LUSD_DISTRIBUTOR = process.env.NEXT_PUBLIC_LUSD_DISTRIBUTOR ?? ''
const VAULT_CAP_XLM = Number(process.env.VAULT_CAP_XLM ?? 1_000_000)

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

async function checkCapBreach(): Promise<Alert | null> {
  try {
    const { callXlm } = await computeOpenExposure()
    const pct = VAULT_CAP_XLM > 0 ? (callXlm / VAULT_CAP_XLM) * 100 : 0
    const fields = [
      { label: 'open_call_xlm', value: callXlm.toFixed(0) },
      { label: 'cap_xlm', value: VAULT_CAP_XLM.toFixed(0) },
      { label: 'utilization_pct', value: pct.toFixed(2) },
    ]
    if (pct >= 100) {
      return {
        severity: 'critical',
        title: 'Vault cap reached',
        message: `Covered-call vault is at ${pct.toFixed(1)}% of cap. New call deposits are being rejected.`,
        fields,
      }
    }
    if (pct >= CAP_WARN_PCT) {
      return {
        severity: 'warning',
        title: 'Vault filling up',
        message: `Covered-call vault is at ${pct.toFixed(1)}% of cap (warn at ${CAP_WARN_PCT}%).`,
        fields,
      }
    }
    return null
  } catch (e: any) {
    return {
      severity: 'critical',
      title: 'Cap check blind',
      message: `Could not compute open exposure: ${e?.message ?? 'unknown'}. Utilization is unknown.`,
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

async function fetchCloses(interval: string, limit: number): Promise<number[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=XLMUSDT&interval=${interval}&limit=${limit}`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`binance klines ${res.status}`)
  const rows = (await res.json()) as unknown[]
  // kline tuple: [openTime, open, high, low, close, ...]; close is index 4.
  return rows
    .map((row) => parseFloat((row as string[])[4]))
    .filter((n) => isFinite(n) && n > 0)
}

async function checkVolSpike(): Promise<Alert | null> {
  try {
    // Short window: 60×1m ≈ last hour. Baseline: 24×1h ≈ last day.
    const [shortCloses, baseCloses] = await Promise.all([
      fetchCloses('1m', 60),
      fetchCloses('1h', 24),
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

    const ratio = shortVol / baseVol
    if (ratio >= VOL_SPIKE_MULT) {
      return {
        severity: 'warning',
        title: 'XLM volatility spike',
        message: `1h realized vol is ${ratio.toFixed(2)}× the 24h baseline (threshold ${VOL_SPIKE_MULT}×). Consider tightening caps or halting deposits.`,
        fields: [
          { label: '1h_vol_annualized', value: shortVol.toFixed(3) },
          { label: '24h_vol_annualized', value: baseVol.toFixed(3) },
          { label: 'ratio', value: ratio.toFixed(2) },
        ],
      }
    }
    return null
  } catch (e: any) {
    // A flaky price feed shouldn't page anyone — info only.
    return {
      severity: 'info',
      title: 'Vol check skipped',
      message: `Could not evaluate volatility: ${e?.message ?? 'unknown'}.`,
    }
  }
}

/**
 * Run every check. Order-independent; failures inside a check are converted to
 * alerts by the check itself, so this never throws.
 */
export async function runMonitorChecks(): Promise<Alert[]> {
  const settled = await Promise.all([
    checkHorizon(),
    checkDb(),
    checkCapBreach(),
    checkVolSpike(),
  ])
  return settled.filter((a): a is Alert => a !== null)
}
