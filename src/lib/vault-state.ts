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

// ---------------------------------------------------------------------------
// Per-epoch vault capacity
//
// Each side of the book carries its own monthly budget, split across three
// epochs per month (a "vault epoch" is one third of a calendar month — see
// currentVaultEpoch). New flow is gated against the *current epoch's* share so
// the book fills gradually instead of all at once, and the cap automatically
// resets when the next epoch begins.
//
//   covered call:      1,500,000 XLM / month  → 500,000 XLM per epoch
//   cash-secured put:    150,000 USD / month  →  50,000 USD per epoch
//
// The two sides are tracked independently: a full call vault never blocks puts
// and vice versa.
// ---------------------------------------------------------------------------
export const EPOCHS_PER_MONTH = Number(process.env.VAULT_EPOCHS_PER_MONTH ?? 3)
export const CALL_MONTHLY_CAP_XLM = Number(
  process.env.VAULT_CALL_MONTHLY_CAP_XLM ?? 1_500_000
)
export const PUT_MONTHLY_CAP_USD = Number(
  process.env.VAULT_PUT_MONTHLY_CAP_USD ?? 150_000
)
export const CALL_EPOCH_CAP_XLM = CALL_MONTHLY_CAP_XLM / EPOCHS_PER_MONTH
export const PUT_EPOCH_CAP_USD = PUT_MONTHLY_CAP_USD / EPOCHS_PER_MONTH

export interface VaultEpoch {
  /** Inclusive start of the current epoch (UTC). */
  start: Date
  /** Exclusive end of the current epoch (UTC) — start of the next one. */
  end: Date
  /** 0, 1 or 2 — which third of the month this epoch is. */
  index: number
  /** e.g. "2026-05" — the calendar month this epoch belongs to. */
  monthKey: string
}

/**
 * The current "vault epoch": one third of the calendar month, in UTC.
 *   index 0 → days 1–10
 *   index 1 → days 11–20
 *   index 2 → day 21 → end of month
 * Three epochs per month by construction, so the monthly cap divided by
 * EPOCHS_PER_MONTH is exactly one epoch's share. Distinct from the weekly
 * risk epoch in triggers.ts (which gates the loss-cap breaker).
 */
export function currentVaultEpoch(now = new Date()): VaultEpoch {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const day = now.getUTCDate()

  let index: number
  let startDay: number
  if (day <= 10) {
    index = 0
    startDay = 1
  } else if (day <= 20) {
    index = 1
    startDay = 11
  } else {
    index = 2
    startDay = 21
  }

  const start = new Date(Date.UTC(y, m, startDay, 0, 0, 0, 0))
  const end =
    index === 0
      ? new Date(Date.UTC(y, m, 11, 0, 0, 0, 0))
      : index === 1
        ? new Date(Date.UTC(y, m, 21, 0, 0, 0, 0))
        : new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0))

  return {
    start,
    end,
    index,
    monthKey: `${y}-${String(m + 1).padStart(2, '0')}`,
  }
}

export interface EpochFlow {
  /** XLM collateral sold into the covered-call vault this epoch. */
  callXlm: number
  /** USD notional sold into the cash-secured-put vault this epoch (LUSD ≈ $1). */
  putUsd: number
  epoch: VaultEpoch
}

/**
 * How much each side has sold *in the current epoch* — the flow the per-epoch
 * caps gate against. Unlike open exposure this resets every epoch, so stale
 * test positions from earlier epochs never inflate it. Throws if the DB is
 * unreachable so callers fail closed.
 */
export async function computeEpochFlow(now = new Date()): Promise<EpochFlow> {
  await ensureSchema()
  const pool = getPool()
  const epoch = currentVaultEpoch(now)
  const res = await pool.query(
    `select
       coalesce(sum(case when subtype = 'call'
                         then (metadata->>'collateralAmount')::float8 end), 0)::float8 as call_xlm,
       coalesce(sum(case when subtype = 'put'
                         then amount end), 0)::float8 as put_usd
     from transactions
     where type = 'deposit'
       and subtype in ('call', 'put')
       and tx_hash is not null
       and created_at >= $1
       and created_at < $2`,
    [epoch.start.toISOString(), epoch.end.toISOString()]
  )
  const row = res.rows[0] ?? {}
  return {
    callXlm: Number(row.call_xlm ?? 0),
    putUsd: Number(row.put_usd ?? 0),
    epoch,
  }
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
