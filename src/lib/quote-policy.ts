import { getPool, ensureSchema } from './db'

/**
 * Underwriting policy, checked before the quoter will sign.
 *
 * The vault contract enforces the limits that must hold no matter who is
 * asking — position size, per-expiry exposure, and pool solvency. Those are
 * trustless: they hold even if this server is compromised or offline.
 *
 * The limits here are different in kind. They are concentration policy — how
 * much of the book one wallet may hold, and how much inventory the protocol
 * wants against a single strike — and they depend on off-chain history the
 * contract has no view of. The protocol enforces them the only way it can
 * without taking custody: by declining to sign the quote. Without a quoter
 * signature the contract will not open the position, so a refusal here is as
 * final as a contract-level revert, while a compromised quoter key still
 * cannot exceed what the contract itself allows.
 *
 * These checks read; they reserve nothing. Two quote requests racing can each
 * see the same history and both pass, overshooting a per-wallet allowance by
 * at most one position. The previous rail closed that window with an advisory
 * lock around a pending row, which it could do because it also wrote the row.
 * The quoter writes nothing.
 *
 * A nonce does not close this window. Soroban's auth layer already carries one:
 * `SorobanCredentials::Address` holds a nonce and an expiration ledger, and the
 * host rejects an entry that reuses either. But replay is not the failure mode
 * here. The race is between two distinct quotes, each honest, each signed once,
 * neither a replay of the other. Closing it properly means the quoter reserving
 * what it signs, so an outstanding signature counts against the allowance
 * before the position exists on chain — that is a write, and it brings back the
 * pending-row bookkeeping this rail was built to shed.
 *
 * So the overshoot is accepted rather than fixed. It is bounded at one position
 * per race, and the contract's own caps — position size, per-expiry exposure,
 * pool solvency, premium ceiling — hold no matter how many requests race, so
 * the worst case stays inside limits that do not depend on this server.
 */

export class PolicyRejection extends Error {
  code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'PolicyRejection'
    this.code = code
  }
}

export interface PolicyInput {
  address: string
  type: 'call' | 'put'
  /** Collateral being escrowed (XLM for calls, cash for puts). */
  collateralAmount: number
  /** USD notional (call: collateral × spot; put: collateral). */
  notionalUsd: number
  strikePrice: number
  /** ±fraction grouping strikes for the per-strike cap (e.g. 0.01). */
  strikeBucketPct: number
  expiryIso: string
  /** Caps, passed in so the route's env-derived values stay authoritative. */
  maxUserNotionalUsd: number
  strikeInventoryLimitUsd: number
  /** Per-wallet allowance PER EXPIRY, in collateral units. */
  maxUserEpochCallXlm: number
  maxUserEpochPutUsd: number
}

/**
 * Throws `PolicyRejection` if the protocol should decline to quote. Any other
 * throw means the history could not be read — callers must fail closed, since
 * an allowance that cannot be checked has not been satisfied.
 */
export async function assertQuoteAllowed(input: PolicyInput): Promise<void> {
  await ensureSchema()
  const pool = getPool()

  // Per-wallet 30-day notional (USD).
  const userRes = await pool.query(
    `select coalesce(sum(amount), 0)::float as sum
       from transactions
      where address = $1
        and type = 'deposit'
        and (subtype is null or subtype != 'swap')
        and created_at > now() - interval '30 days'`,
    [input.address]
  )
  const userNotional = parseFloat(userRes.rows[0]?.sum ?? '0')
  if (userNotional + input.notionalUsd > input.maxUserNotionalUsd) {
    throw new PolicyRejection(
      `per-wallet 30d limit exceeded — you have $${userNotional.toFixed(0)} of $${input.maxUserNotionalUsd} already deposited. Wait for some positions to expire.`,
      'user_limit_exceeded'
    )
  }

  // Per-wallet allowance PER EXPIRY, in collateral units. Cumulative within
  // one expiry bucket: 1k now + 9k later is fine, the 10,001st unit is not.
  // Each open expiry is a fresh allowance — a user may fill all three epochs
  // to their personal max, which is intended (the contract's own per-expiry
  // exposure cap still bounds total vault risk on that date).
  const dateKey = input.expiryIso.slice(0, 10)
  const epochRes = await pool.query(
    `select coalesce(sum(case when subtype = 'call'
                              then (metadata->>'collateralAmount')::float8 end), 0)::float8 as call_xlm,
            coalesce(sum(case when subtype = 'put'
                              then amount end), 0)::float8 as put_usd
       from transactions
      where type = 'deposit'
        and subtype in ('call', 'put')
        and address = $1
        and metadata ? 'expiryIso'
        and left(metadata->>'expiryIso', 10) = $2`,
    [input.address, dateKey]
  )
  const used =
    input.type === 'call'
      ? Number(epochRes.rows[0]?.call_xlm ?? 0)
      : Number(epochRes.rows[0]?.put_usd ?? 0)
  const limit =
    input.type === 'call' ? input.maxUserEpochCallXlm : input.maxUserEpochPutUsd
  if (used + input.collateralAmount > limit) {
    const remaining = Math.max(0, limit - used)
    const unit = input.type === 'call' ? 'XLM' : 'USD'
    throw new PolicyRejection(
      `per-wallet limit for this expiry exceeded — you have used ${used.toFixed(0)} of ${limit.toFixed(0)} ${unit} (${remaining.toFixed(0)} ${unit} remaining). Other expiries have a fresh allowance.`,
      'user_epoch_limit_exceeded'
    )
  }

  // Per-strike 14-day inventory (USD), global across wallets. Stops the whole
  // book's short delta concentrating on one price point.
  const lo = input.strikePrice * (1 - input.strikeBucketPct)
  const hi = input.strikePrice * (1 + input.strikeBucketPct)
  const strikeRes = await pool.query(
    `select coalesce(sum(amount), 0)::float as sum
       from transactions
      where type = 'deposit'
        and (subtype is null or subtype != 'swap')
        and metadata ? 'strikePrice'
        and (metadata->>'strikePrice')::float8 between $1 and $2
        and created_at > now() - interval '14 days'`,
    [lo, hi]
  )
  const strikeNotional = parseFloat(strikeRes.rows[0]?.sum ?? '0')
  if (strikeNotional + input.notionalUsd > input.strikeInventoryLimitUsd) {
    throw new PolicyRejection(
      `strike $${input.strikePrice.toFixed(4)} is full — $${strikeNotional.toFixed(0)} of $${input.strikeInventoryLimitUsd} already sold against this strike. Pick a different strike.`,
      'strike_limit_exceeded'
    )
  }
}
