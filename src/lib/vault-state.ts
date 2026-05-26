import { getPool, ensureSchema } from './db'

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
