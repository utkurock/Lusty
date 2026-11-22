import { ensureSchema, getPool } from '@/lib/db'
import type { UnderlyingAsset } from '@/lib/assets'
import { scanOpens, type VaultEvent } from '@/lib/contract-events'
import { getVaultLimits, type VaultLimits, type OptionSide } from '@/lib/vault-contract'
import { getSpot } from '@/lib/spot'
import { positionKey } from '@/lib/settlement'
import type { Alert } from './notify'

/**
 * Position activity that is allowed and still worth a look.
 *
 * Every limit below is enforced on chain, so nothing here is a breach. It is
 * the shape the protocol's own trusted keys would leave if they were misused,
 * and the shape someone working the book would leave while inside the rules:
 *
 *   • a burst of opens — a script, not a market
 *   • one wallet holding most of a leg's open interest — one counterparty the
 *     book now depends on at expiry
 *   • several positions written at the position cap — sizing to the limit
 *     rather than to a view
 *   • premiums near the ceiling — the one thing a leaked quoter key buys is a
 *     premium as large as `max_premium_bps` lets it be, and the contract will
 *     pay it
 *
 * Opens are read off the chain (`deposit` events), so a position opened
 * without the app is counted like any other. Holdings are read from the quote
 * reservations: every position needs a quoter's signature, so every position
 * has one, including those the app was never told about.
 *
 * Split into a pure rule and a reader so the rule can be tested at every
 * boundary without a network.
 */

const num = (v: string | undefined, d: number) => {
  const n = Number(v)
  return isFinite(n) && n > 0 ? n : d
}

/** How far back opens are counted. */
const WINDOW_MS = num(process.env.MONITOR_ACTIVITY_WINDOW_MS, 3_600_000)
/** Opens in the window, per book, that make a burst. */
const BURST_OPENS = num(process.env.MONITOR_ACTIVITY_BURST_OPENS, 20)
/** A position at or above this share of the position cap is "at the cap". */
const AT_CAP_PCT = num(process.env.MONITOR_ACTIVITY_AT_CAP_PCT, 95)
/** How many at-the-cap opens in the window are reported. */
const AT_CAP_OPENS = num(process.env.MONITOR_ACTIVITY_AT_CAP_OPENS, 3)
/** A premium at or above this share of the ceiling is "near" it. */
const NEAR_CEILING_PCT = num(process.env.MONITOR_ACTIVITY_PREMIUM_PCT, 90)
/** One wallet's share of a leg's open interest that is reported. */
const WALLET_SHARE_PCT = num(process.env.MONITOR_ACTIVITY_WALLET_SHARE_PCT, 40)
/**
 * A leg's open interest, in full-size positions, before concentration means
 * anything: in a book one or two positions deep, somebody always holds most of it.
 */
const MIN_DEPTH_POSITIONS = num(process.env.MONITOR_ACTIVITY_MIN_DEPTH, 3)

/** Ledger close time, for turning the window into a lookback. Errs long. */
const LEDGER_SECS = 5

export interface Thresholds {
  burstOpens: number
  atCapPct: number
  atCapOpens: number
  nearCeilingPct: number
  walletSharePct: number
  minDepthPositions: number
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  burstOpens: BURST_OPENS,
  atCapPct: AT_CAP_PCT,
  atCapOpens: AT_CAP_OPENS,
  nearCeilingPct: NEAR_CEILING_PCT,
  walletSharePct: WALLET_SHARE_PCT,
  minDepthPositions: MIN_DEPTH_POSITIONS,
}

/** One wallet's open collateral on one leg, and the leg's total. */
export interface Holding {
  side: OptionSide
  owner: string
  amount: number
  total: number
}

export interface ActivityReading {
  /** This book's opens inside the window. */
  opens: VaultEvent[]
  /** The largest holder on each leg. */
  holdings: Holding[]
  limits: VaultLimits
  /** The underlying in cash, for valuing a call's collateral. Null if unknown. */
  spot: number | null
}

const short = (g: string) => `${g.slice(0, 4)}…${g.slice(-4)}`
const cap = (l: VaultLimits, side: OptionSide) => (side === 'call' ? l.maxPositionCall : l.maxPositionPut)

/** A premium as basis points of the collateral it was paid against, as the contract measures it. */
export function premiumBps(e: VaultEvent, spot: number | null): number | null {
  if (!e.amount || e.premiumCash === undefined) return null
  const value = e.side === 'put' ? e.amount : spot ? e.amount * spot : null
  return value ? (e.premiumCash / value) * 10_000 : null
}

/** The alert a book's recent activity calls for. Pure. */
export function activityAlert(
  asset: UnderlyingAsset,
  r: ActivityReading,
  t: Thresholds = DEFAULT_THRESHOLDS,
  windowMs: number = WINDOW_MS,
): Alert | null {
  const unit = asset.symbol
  const key = (e: VaultEvent) => positionKey(asset.symbol, Number(e.id), e.contractId)
  const findings: string[] = []
  const fields = [
    { label: 'underlying', value: unit },
    { label: 'opens_in_window', value: String(r.opens.length) },
  ]
  const minutes = Math.round(windowMs / 60_000)

  if (r.opens.length >= t.burstOpens) {
    const wallets = new Set(r.opens.map((e) => e.owner)).size
    findings.push(
      `${r.opens.length} positions opened in the last ${minutes} minutes from ${wallets} wallet(s) ` +
        `(reported at ${t.burstOpens}).`,
    )
  }

  const atCap = r.opens.filter((e) => {
    const c = cap(r.limits, e.side ?? 'call')
    return c > 0 && (e.amount ?? 0) >= (c * t.atCapPct) / 100
  })
  if (atCap.length >= t.atCapOpens) {
    findings.push(
      `${atCap.length} positions in the last ${minutes} minutes were written at ≥${t.atCapPct}% of the ` +
        `position cap: ${atCap.map(key).join(', ')}.`,
    )
    fields.push({ label: 'at_cap', value: String(atCap.length) })
  }

  const ceiling = r.limits.maxPremiumBps
  const near = r.opens
    .map((e) => ({ e, bps: premiumBps(e, r.spot) }))
    .filter(({ bps }) => bps !== null && ceiling > 0 && bps >= (ceiling * t.nearCeilingPct) / 100)
  if (near.length > 0) {
    findings.push(
      `${near.length} premium(s) paid at ≥${t.nearCeilingPct}% of the ${ceiling} bps ceiling — the shape a ` +
        `misused quoter key leaves: ` +
        near.map(({ e, bps }) => `${key(e)} ${bps!.toFixed(0)} bps`).join(', ') +
        '.',
    )
    fields.push({ label: 'near_ceiling', value: String(near.length) })
  }

  for (const h of r.holdings) {
    const full = cap(r.limits, h.side)
    if (h.total <= 0 || full <= 0 || h.total < full * t.minDepthPositions) continue
    const pct = (h.amount / h.total) * 100
    if (pct < t.walletSharePct) continue
    findings.push(
      `${short(h.owner)} holds ${pct.toFixed(0)}% of the ${h.side} leg's open interest ` +
        `(${h.amount} of ${h.total}).`,
    )
    fields.push({ label: `${h.side}_top_wallet_pct`, value: pct.toFixed(1) })
  }

  if (findings.length === 0) return null
  return {
    severity: 'warning',
    title: `${unit}: abnormal position activity`,
    message: `Inside every limit, and still worth a look. ${findings.join(' ')}`,
    fields,
  }
}

/** The largest open holder on each leg of a book, from the quote reservations. */
async function readHoldings(asset: UnderlyingAsset, now: Date): Promise<Holding[]> {
  await ensureSchema()
  // 'opened' and 'indexed' are positions known to exist on chain. An expired
  // one is settled or about to be, and is no longer the book's to depend on.
  const { rows } = await getPool().query(
    `with open as (
       select subtype, address, sum(collateral)::float8 as amount
         from quote_reservations
        where underlying = $1
          and state in ('opened', 'indexed')
          and expiry_iso > $2
        group by subtype, address
     )
     select distinct on (subtype)
            subtype, address, amount, sum(amount) over (partition by subtype) as total
       from open
      order by subtype, amount desc`,
    [asset.symbol, now.toISOString()],
  )
  return rows.map((r: any) => ({
    side: r.subtype,
    owner: r.address,
    amount: Number(r.amount),
    total: Number(r.total),
  }))
}

export async function checkAbnormalActivity(asset: UnderlyingAsset): Promise<Alert | null> {
  try {
    const now = new Date()
    const lookback = Math.ceil(WINDOW_MS / 1000 / LEDGER_SECS)
    const [all, holdings, limits, spot] = await Promise.all([
      scanOpens(lookback),
      readHoldings(asset, now),
      getVaultLimits(asset),
      // Only a call's premium needs it; a put still checks without it.
      getSpot(asset).then((q) => q.price).catch(() => null),
    ])
    const since = now.getTime() - WINDOW_MS
    const opens = all.filter(
      (e) => e.contractId === asset.contracts.vault && Date.parse(e.at) >= since,
    )
    return activityAlert(asset, { opens, holdings, limits, spot })
  } catch (e: any) {
    return {
      severity: 'warning',
      title: `${asset.symbol}: position activity check failed`,
      message: `Could not read ${asset.symbol}'s recent opens or holdings: ${e?.message ?? 'unknown'}.`,
    }
  }
}
