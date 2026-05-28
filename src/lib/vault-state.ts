import { getPool, ensureSchema } from './db'
import { upcomingExpiryDates, expiryLabel } from './expiries'

/**
 * Vault exposure, computed from the protocol's own record of open positions.
 *
 * Why this exists (BUG-1): utilization used to be derived from the
 * distributor's raw Horizon XLM balance minus a fixed baseline
 * (`xlmBalance - VAULT_XLM_BASELINE`). That number conflates real open
 * exposure with everything else that lands in the distributor wallet —
 * faucet XLM users pull while testing, seed capital, and month-old test
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
 * Collateral side: XLM for covered calls, LUSD for cash-secured puts.
 */

// Positions whose expiry is more than this many days in the past are treated
// as abandoned (never claimed back) and dropped from open exposure. Generous
// enough to cover a normal claim window; tight enough to exclude stale test
// positions. Override with VAULT_EXPOSURE_GRACE_DAYS.
const EXPOSURE_GRACE_DAYS = Number(process.env.VAULT_EXPOSURE_GRACE_DAYS ?? 7)

// ---------------------------------------------------------------------------
// Per-expiry vault capacity ("epochs")
//
// Each option expiry (the rolling Fridays users pick in the strike selector)
// is an independent capacity bucket. All EPOCHS_PER_MONTH upcoming expiries are
// open for deposits at the same time; each carries its own cap:
//
//   covered call:      500,000 XLM  per expiry   (1,500,000 / month combined)
//   cash-secured put:   50,000 USD  per expiry   (  150,000 / month combined)
//
// A single expiry filling up blocks only that expiry — the others stay open.
// The Earn page bar shows the combined fill across all open expiries; the
// timeline and strike selector show each expiry's own fill and "full" state.
//
// The two sides are tracked independently: a full call bucket never blocks puts.
// ---------------------------------------------------------------------------
export const EPOCHS_PER_MONTH = Number(process.env.VAULT_EPOCHS_PER_MONTH ?? 3)
export const CALL_MONTHLY_CAP_XLM = Number(
  process.env.VAULT_CALL_MONTHLY_CAP_XLM ?? 1_500_000
)
export const PUT_MONTHLY_CAP_USD = Number(
  process.env.VAULT_PUT_MONTHLY_CAP_USD ?? 150_000
)
// Per-expiry ("per-epoch") caps — the cap that gates a single expiry bucket.
export const CALL_EPOCH_CAP_XLM = CALL_MONTHLY_CAP_XLM / EPOCHS_PER_MONTH
export const PUT_EPOCH_CAP_USD = PUT_MONTHLY_CAP_USD / EPOCHS_PER_MONTH

/** UTC calendar-date key (YYYY-MM-DD) identifying an expiry bucket. */
export function expiryDateKey(d: Date | string): string {
  return new Date(d).toISOString().slice(0, 10)
}

export interface ExpirySold {
  /** XLM covered-call collateral sold for this expiry. */
  callXlm: number
  /** USD put notional sold for this expiry (LUSD ≈ $1). */
  putUsd: number
}

/**
 * Collateral sold per expiry bucket, keyed by UTC date (YYYY-MM-DD). Matches on
 * the leading 10 chars of the stored expiryIso — canonical expiries are
 * "YYYY-MM-DDT08:00:00.000Z", so this needs no timestamptz cast (a single
 * malformed legacy row therefore can't throw and, because the cap fails closed,
 * block every deposit). Every requested key is present (zero-filled). Throws if
 * the DB is unreachable so callers fail closed.
 */
export async function computeExpirySold(
  dateKeys: string[]
): Promise<Map<string, ExpirySold>> {
  const map = new Map<string, ExpirySold>()
  for (const k of dateKeys) map.set(k, { callXlm: 0, putUsd: 0 })
  if (dateKeys.length === 0) return map
  await ensureSchema()
  const res = await getPool().query(
    `select left(metadata->>'expiryIso', 10) as date_key,
            coalesce(sum(case when subtype = 'call'
                              then (metadata->>'collateralAmount')::float8 end), 0)::float8 as call_xlm,
            coalesce(sum(case when subtype = 'put'
                              then amount end), 0)::float8 as put_usd
       from transactions
      where type = 'deposit'
        and subtype in ('call', 'put')
        and tx_hash is not null
        and metadata ? 'expiryIso'
        and left(metadata->>'expiryIso', 10) = any($1::text[])
      group by 1`,
    [dateKeys]
  )
  for (const row of res.rows) {
    if (!row.date_key) continue
    map.set(row.date_key, {
      callXlm: Number(row.call_xlm ?? 0),
      putUsd: Number(row.put_usd ?? 0),
    })
  }
  return map
}

export interface ExpiryBucket {
  /** Canonical UTC expiry timestamp (Friday 08:00 UTC). */
  expiryIso: string
  /** UTC date key (YYYY-MM-DD). */
  dateKey: string
  /** Short label, e.g. "May_01". */
  label: string
  /** XLM sold into this expiry's covered-call bucket. */
  callXlm: number
  /** USD sold into this expiry's cash-secured-put bucket. */
  putUsd: number
}

/**
 * The currently-open expiry buckets (the next EPOCHS_PER_MONTH rolling Fridays)
 * with how much has been sold into each. Uses the shared expiry generator so
 * these stay in lockstep with the expiries the UI offers. Throws if the DB is
 * unreachable.
 */
export async function computeOpenBuckets(
  now = new Date()
): Promise<ExpiryBucket[]> {
  const dates = upcomingExpiryDates(now, EPOCHS_PER_MONTH)
  const keys = dates.map((d) => expiryDateKey(d))
  const sold = await computeExpirySold(keys)
  return dates.map((d) => {
    const dateKey = expiryDateKey(d)
    const s = sold.get(dateKey) ?? { callXlm: 0, putUsd: 0 }
    return {
      expiryIso: d.toISOString(),
      dateKey,
      label: expiryLabel(d),
      callXlm: s.callXlm,
      putUsd: s.putUsd,
    }
  })
}

export interface OpenExposure {
  /** Open covered-call collateral still owed back / assignable, in XLM. */
  callXlm: number
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
export async function computeOpenExposure(): Promise<OpenExposure> {
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
                         then (d.metadata->>'collateralAmount')::float8 end), 0)::float8 as call_xlm,
       coalesce(sum(case when d.subtype = 'put'
                         then (d.metadata->>'collateralAmount')::float8 end), 0)::float8 as put_lusd
     from transactions d
     where d.type = 'deposit'
       and d.subtype in ('call', 'put')
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
    [cutoffIso]
  )
  const row = res.rows[0] ?? {}
  return {
    callXlm: Number(row.call_xlm ?? 0),
    putLusd: Number(row.put_lusd ?? 0),
    graceDays: EXPOSURE_GRACE_DAYS,
  }
}
