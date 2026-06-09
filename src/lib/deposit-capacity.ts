import { getPool, ensureSchema } from './db'
import {
  CALL_EPOCH_CAP_XLM,
  PUT_EPOCH_CAP_USD,
} from './vault-state'

/**
 * Atomic deposit capacity reservation (fixes the cap TOCTOU race).
 *
 * The old flow read the per-user / per-strike / per-epoch sums from
 * `transactions`, then paid the premium, then inserted the row. N concurrent
 * requests would all read the same "existing" total, all pass, and overshoot
 * every cap by up to N×. This module closes that window:
 *
 *   1. All three cap checks AND the position insert run in ONE database
 *      transaction on ONE connection, serialized by pg_advisory_xact_lock —
 *      concurrent deposits queue behind each other, so each sees the
 *      previous one's pending row.
 *   2. The row is inserted BEFORE the premium payout, marked
 *      metadata.pending=true. It counts toward every cap immediately. After
 *      a successful payout `finalizeDeposit` fills in the premium fields; a
 *      failed payout calls `cancelPendingDeposit` to delete it.
 *
 * Side benefit: if the post-payout finalize fails (DB blip), the position
 * still exists with full claim metadata and still counts toward the caps —
 * the old code lost the row entirely in that case.
 *
 * Everything runs on a single pooled client so a small pool (max=3) cannot
 * self-starve: each concurrent request needs exactly one connection whether
 * it holds the lock or waits for it.
 */

// Single global lock key for vault deposit capacity. Per-strike and per-epoch
// caps are global (not per-user), so one key serializes correctly; the lock is
// held only for a handful of indexed SELECTs + one INSERT (milliseconds).
const DEPOSIT_CAPACITY_LOCK_KEY = 0x1057_0ca5 // "LUSTY-OCAS" — vault deposit caps

export class CapExceededError extends Error {
  code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'CapExceededError'
    this.code = code
  }
}

export interface CapacityInput {
  address: string
  type: 'call' | 'put'
  /** On-chain collateral received (XLM for calls, LUSD for puts). */
  collateralAmount: number
  /** USD notional of this deposit (call: collateral × spot; put: collateral). */
  notionalUsd: number
  strikePrice: number
  /** ±fraction grouping strikes for the per-strike cap (e.g. 0.01). */
  strikeBucketPct: number
  expiryIso: string
  daysToExpiry: number
  txHash: string
  /** Caps, passed in so the route's env-derived values stay authoritative. */
  maxUserNotionalUsd: number
  strikeInventoryLimitUsd: number
  /** Full metadata to persist on the position row (claim reads this). */
  metadata: Record<string, unknown>
}

export async function reserveDepositCapacity(
  input: CapacityInput
): Promise<number> {
  await ensureSchema()
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query('select pg_advisory_xact_lock($1)', [
      DEPOSIT_CAPACITY_LOCK_KEY,
    ])

    // Per-user 30-day notional (USD). Same predicate as before, now serialized.
    const userRes = await client.query(
      `select coalesce(sum(amount), 0)::float as sum
       from transactions
       where address = $1
         and type = 'deposit'
         and (subtype is null or subtype != 'swap')
         and created_at > now() - interval '30 days'`,
      [input.address]
    )
    const existingUserNotional = parseFloat(userRes.rows[0]?.sum ?? '0')
    if (existingUserNotional + input.notionalUsd > input.maxUserNotionalUsd) {
      await client.query('rollback')
      throw new CapExceededError(
        `per-wallet 30d limit exceeded — you have $${existingUserNotional.toFixed(0)} of $${input.maxUserNotionalUsd} already deposited. Wait for some positions to expire.`,
        'user_limit_exceeded'
      )
    }

    // Per-strike 14-day inventory (USD).
    const lo = input.strikePrice * (1 - input.strikeBucketPct)
    const hi = input.strikePrice * (1 + input.strikeBucketPct)
    const strikeRes = await client.query(
      `select coalesce(sum(amount), 0)::float as sum
       from transactions
       where type = 'deposit'
         and (subtype is null or subtype != 'swap')
         and metadata ? 'strikePrice'
         and (metadata->>'strikePrice')::float8 between $1 and $2
         and created_at > now() - interval '14 days'`,
      [lo, hi]
    )
    const existingStrikeNotional = parseFloat(strikeRes.rows[0]?.sum ?? '0')
    if (
      existingStrikeNotional + input.notionalUsd >
      input.strikeInventoryLimitUsd
    ) {
      await client.query('rollback')
      throw new CapExceededError(
        `strike $${input.strikePrice.toFixed(4)} is full — $${existingStrikeNotional.toFixed(0)} of $${input.strikeInventoryLimitUsd} already sold against this strike. Pick a different strike.`,
        'strike_limit_exceeded'
      )
    }

    // Per-expiry epoch cap (call in XLM, put in USD). Mirrors
    // vault-state.computeExpirySold for a single date key.
    const dateKey = input.expiryIso.slice(0, 10)
    const epochRes = await client.query(
      `select coalesce(sum(case when subtype = 'call'
                                then (metadata->>'collateralAmount')::float8 end), 0)::float8 as call_xlm,
              coalesce(sum(case when subtype = 'put'
                                then amount end), 0)::float8 as put_usd
         from transactions
        where type = 'deposit'
          and subtype in ('call', 'put')
          and tx_hash is not null
          and metadata ? 'expiryIso'
          and left(metadata->>'expiryIso', 10) = $1`,
      [dateKey]
    )
    const soldCallXlm = Number(epochRes.rows[0]?.call_xlm ?? 0)
    const soldPutUsd = Number(epochRes.rows[0]?.put_usd ?? 0)
    if (input.type === 'call') {
      const projectedXlm = soldCallXlm + input.collateralAmount
      if (projectedXlm > CALL_EPOCH_CAP_XLM) {
        await client.query('rollback')
        throw new CapExceededError(
          `covered-call epoch is full for this expiry — ${projectedXlm.toFixed(0)}/${CALL_EPOCH_CAP_XLM.toFixed(0)} XLM. Pick another expiry. Your collateral was received but no upfront will be paid. Withdraw via support.`,
          'cap_exceeded'
        )
      }
    } else {
      const projectedUsd = soldPutUsd + input.collateralAmount
      if (projectedUsd > PUT_EPOCH_CAP_USD) {
        await client.query('rollback')
        throw new CapExceededError(
          `cash-secured-put epoch is full for this expiry — $${projectedUsd.toFixed(0)}/$${PUT_EPOCH_CAP_USD.toFixed(0)}. Pick another expiry. Your collateral was received but no upfront will be paid. Withdraw via support.`,
          'cap_exceeded'
        )
      }
    }

    // All caps clear — insert the pending position row inside the same
    // transaction so the next lock holder counts it.
    await client.query(
      `insert into users (address) values ($1)
       on conflict (address) do update
         set last_seen = now(), connect_count = users.connect_count + 1`,
      [input.address]
    )
    const ins = await client.query(
      `insert into transactions
         (address, type, subtype, amount, asset, tx_hash, metadata)
       values ($1, 'deposit', $2, $3, $4, $5, $6)
       returning id`,
      [
        input.address,
        input.type,
        input.notionalUsd,
        input.type === 'call' ? 'XLM' : 'LUSD',
        input.txHash,
        JSON.stringify({ ...input.metadata, pending: true }),
      ]
    )
    await client.query('commit')
    return Number(ins.rows[0].id)
  } catch (e) {
    // Roll back anything still open (no-op after an explicit rollback/commit).
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * Mark a pending deposit as paid: record the premium payout and drop the
 * pending flag. Failure here is non-fatal for the caller — the position row
 * already exists with full claim metadata and counts toward all caps.
 */
export async function finalizeDeposit(
  id: number,
  premiumHash: string,
  premiumAmount: number
): Promise<void> {
  const pool = getPool()
  await pool.query(
    `update transactions
        set premium_hash = $2,
            premium_amount = $3,
            metadata = metadata - 'pending'
      where id = $1`,
    [id, premiumHash, premiumAmount]
  )
}

/**
 * Remove a pending deposit whose premium payout failed, so it stops counting
 * toward the caps and the user can retry the same txHash.
 */
export async function cancelPendingDeposit(id: number): Promise<void> {
  try {
    const pool = getPool()
    await pool.query(
      `delete from transactions
        where id = $1 and metadata->>'pending' = 'true'`,
      [id]
    )
  } catch (e) {
    // Best-effort: an orphaned pending row over-counts the caps (conservative
    // direction) and surfaces in the admin transactions view for cleanup.
    console.error('cancelPendingDeposit failed:', e)
  }
}
