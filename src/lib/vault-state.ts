import type { UnderlyingAsset } from './assets'
import { getPool, ensureSchema } from './db'
import { upcomingExpiryDates, expiryLabel, expiryUtilization } from './expiries'

/**
 * Vault exposure, computed from the protocol's own record of open positions.
 *
 * Why this exists (BUG-1): utilization used to be derived from the
 * distributor's raw Horizon balance minus a fixed baseline. That number
 * conflates real open exposure with everything else that lands in the
 * distributor wallet — faucet payouts users pull while testing, seed capital,
 * and month-old test
 * positions whose collateral was never claimed back. The result was a
 * utilization figure that ran to six-figure percentages and silently broke
 * the vault cap check (it would report "cap exceeded" off noise, not risk).
 *
 * The honest metric is "open notional": the collateral the vault is still on
 * the hook for right now. That is computable from the DB:
 *   - the deposit was recorded (type='deposit', subtype call/put),
 *   - it has not been claimed (no row in the processed_actions replay ledger
 *     keyed by the deposit hash — written atomically before any payout, so it
 *     is the authoritative "settled" marker even if the claim's own
 *     transaction-log insert failed), and
 *   - it has not expired so long ago that it is effectively abandoned test
 *     data rather than live exposure (within the grace window).
 *
 * Collateral side: the book's underlying for covered calls, cash for puts.
 */

// Positions whose expiry is more than this many days in the past are treated
// as abandoned (never claimed back) and dropped from open exposure. Generous
// enough to cover a normal claim window; tight enough to exclude stale test
// positions. Override with VAULT_EXPOSURE_GRACE_DAYS.
const EXPOSURE_GRACE_DAYS = Number(process.env.VAULT_EXPOSURE_GRACE_DAYS ?? 7)

// Each open expiry ("epoch") is its own capacity bucket: the book's own
// `openExpiries` are open at once, each capped independently (call in the
// underlying, put in USD). A full expiry blocks only itself.
//
// The count is the asset's since M2-04. It was one env value for every book,
// which is the one number in the envelope that cannot be shared: it divides a
// monthly capacity into the per-expiry figure M2-05 reconciles against the
// instance's `max_expiry_*`, so a book dividing by another book's count would
// be checked against a bound its own contract never enforces.
export const epochsPerMonth = (asset: UnderlyingAsset): number =>
  asset.expiry.openExpiries

/** Per-expiry cap = the asset's own monthly budget / its own open expiries. */
export const callEpochCap = (asset: UnderlyingAsset): number =>
  asset.callMonthlyCap / epochsPerMonth(asset)
export const putEpochCap = (asset: UnderlyingAsset): number =>
  asset.putMonthlyCapUsd / epochsPerMonth(asset)

export function expiryDateKey(d: Date | string): string {
  return new Date(d).toISOString().slice(0, 10)
}

export interface ExpirySold {
  callUnderlying: number
  putUsd: number
}

// Collateral sold per expiry, keyed by UTC date. Matches the leading 10 chars
// of expiryIso (no timestamptz cast, so a malformed row can't throw and block
// deposits). Throws if the DB is unreachable so callers fail closed.
export async function computeExpirySold(
  dateKeys: string[],
  asset: UnderlyingAsset
): Promise<Map<string, ExpirySold>> {
  const map = new Map<string, ExpirySold>()
  for (const k of dateKeys) map.set(k, { callUnderlying: 0, putUsd: 0 })
  if (dateKeys.length === 0) return map
  await ensureSchema()
  const res = await getPool().query(
    `select left(metadata->>'expiryIso', 10) as date_key,
            coalesce(sum(case when subtype = 'call'
                              then (metadata->>'collateralAmount')::float8 end), 0)::float8 as call_underlying,
            coalesce(sum(case when subtype = 'put'
                              then amount end), 0)::float8 as put_usd
       from transactions
      where type = 'deposit'
        and subtype in ('call', 'put')
        and underlying = $2
        and tx_hash is not null
        and metadata ? 'expiryIso'
        and left(metadata->>'expiryIso', 10) = any($1::text[])
      group by 1`,
    [dateKeys, asset.symbol]
  )
  for (const row of res.rows) {
    if (!row.date_key) continue
    map.set(row.date_key, {
      callUnderlying: Number(row.call_underlying ?? 0),
      putUsd: Number(row.put_usd ?? 0),
    })
  }
  return map
}

export interface ExpiryBucket {
  expiryIso: string
  dateKey: string
  label: string
  callUnderlying: number
  putUsd: number
}

// The open expiry buckets (the book's own schedule) with amounts sold.
export async function computeOpenBuckets(
  now = new Date(),
  asset: UnderlyingAsset
): Promise<ExpiryBucket[]> {
  const dates = upcomingExpiryDates(now, asset.expiry)
  const keys = dates.map((d) => expiryDateKey(d))
  const sold = await computeExpirySold(keys, asset)
  return dates.map((d) => {
    const dateKey = expiryDateKey(d)
    const s = sold.get(dateKey) ?? { callUnderlying: 0, putUsd: 0 }
    return {
      expiryIso: d.toISOString(),
      dateKey,
      label: expiryLabel(d),
      callUnderlying: s.callUnderlying,
      putUsd: s.putUsd,
    }
  })
}

/**
 * The utilization haircut input for one expiry: how full the pool is overall,
 * skewed by where this expiry sits in the ladder. Shared by every path that
 * prices an option so a quote, its co-signature and the recorded position all
 * derive from the same number.
 *
 * Never throws. A DB blip assumes a nearly-full pool, which maximises the
 * haircut — erring towards paying too little rather than too much.
 */
export async function expiryUtilizationFor(
  side: 'call' | 'put',
  expiryIso: string,
  asset: UnderlyingAsset
): Promise<number> {
  try {
    // Both halves of the ratio belong to this asset: its own sold collateral
    // over its own capacity. Filling one book leaves the other's haircut
    // exactly where it was.
    const buckets = await computeOpenBuckets(new Date(), asset)
    const n = buckets.length || 1
    const aggregate =
      side === 'call'
        ? buckets.reduce((a, b) => a + b.callUnderlying, 0) / (callEpochCap(asset) * n)
        : buckets.reduce((a, b) => a + b.putUsd, 0) / (putEpochCap(asset) * n)
    const slot = buckets.findIndex((b) => b.dateKey === expiryDateKey(expiryIso))
    return expiryUtilization(aggregate, slot >= 0 ? slot : 0)
  } catch (err) {
    console.warn('vault-state: util read failed, assuming full pool', err)
    return 0.98
  }
}

export interface OpenExposure {
  /** Open call collateral still owed back, in the book's own units. */
  callUnderlying: number
  /** Open cash-secured-put collateral still owed back / assignable, in LUSD. */
  putLusd: number
  /** Grace window (days past expiry) used for this computation. */
  graceDays: number
}

/**
 * Sum of collateral across open (unclaimed, not-yet-abandoned) positions.
 * Throws if the DB is unreachable — callers should fail closed (a cap check
 * that can't see real exposure must reject, not wave through).
 */
export async function computeOpenExposure(
  asset: UnderlyingAsset
): Promise<OpenExposure> {
  await ensureSchema()
  const pool = getPool()
  // Compare expiry as a string, not a timestamptz cast: the deposit route
  // always stores expiryIso via `new Date(...).toISOString()`, so values are
  // canonical UTC ISO-8601 ("...Z") and sort lexically in time order. This
  // avoids a single malformed legacy row throwing a cast error and, because
  // the cap fails closed, blocking every deposit.
  const cutoffIso = new Date(
    Date.now() - EXPOSURE_GRACE_DAYS * 86400_000
  ).toISOString()
  const res = await pool.query(
    `select
       coalesce(sum(case when d.subtype = 'call'
                         then (d.metadata->>'collateralAmount')::float8 end), 0)::float8 as call_underlying,
       coalesce(sum(case when d.subtype = 'put'
                         then (d.metadata->>'collateralAmount')::float8 end), 0)::float8 as put_lusd
     from transactions d
     where d.type = 'deposit'
       and d.subtype in ('call', 'put')
       and d.underlying = $2
       and d.tx_hash is not null
       and d.metadata ? 'collateralAmount'
       and (
         not (d.metadata ? 'expiryIso')
         or (d.metadata->>'expiryIso') > $1
       )
       and not exists (
         select 1 from processed_actions pa
         where pa.action_type = 'claim'
           and pa.source_hash = d.tx_hash
       )`,
    [cutoffIso, asset.symbol]
  )
  const row = res.rows[0] ?? {}
  return {
    callUnderlying: Number(row.call_underlying ?? 0),
    putLusd: Number(row.put_lusd ?? 0),
    graceDays: EXPOSURE_GRACE_DAYS,
  }
}
