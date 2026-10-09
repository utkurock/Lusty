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
 * What they count. Indexed deposits alone are not enough: a row in
 * `transactions` exists only because the writer's client called
 * /api/vault/deposit after opening, and a client that never calls it opened a
 * position no allowance ever saw. So the quoter reserves what it signs
 * (`reserveQuote`): every signature is a row in `quote_reservations` that
 * counts against the same allowances until it is accounted for — matched to
 * its indexed deposit, found on chain unreported, or shown unused once the
 * signature lapsed.
 *
 * Two requests racing can still each read the history before either reserves,
 * overshooting a per-wallet allowance by one position per race. That is
 * accepted: it is bounded, and the contract's own caps — position size,
 * per-expiry exposure, pool solvency, premium ceiling — hold no matter how many
 * requests race.
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
  /**
   * The underlying being written. Every allowance below is scoped to it: a
   * wallet's BTC history is not a claim on its XLM allowance, and two books'
   * inventory against "the same strike" are not the same inventory — $0.25
   * means nothing on a $77k asset.
   */
  underlying: string
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
  /**
   * The writer's positions as the contract holds them, for deciding whether a
   * lapsed reservation was used. Omitted, lapsed reservations stay counted.
   */
  readPositions?: () => Promise<OnChainPosition[]>
}

/** The terms of a position, as read back from the contract. */
export interface OnChainPosition {
  side: 'call' | 'put'
  collateral: number
  strike: number
  expiry: Date
}

/** Reservations that still count: not yet matched to a deposit, not unused. */
const OUTSTANDING = `state in ('pending','opened')`

/** One position's terms, rounded so a contract read and a request agree. */
function termsKey(side: string, collateral: number, strike: number, expiryMs: number): string {
  return `${side}|${collateral.toFixed(6)}|${strike.toFixed(6)}|${expiryMs}`
}

/**
 * Settle the writer's lapsed reservations against the chain. A signature past
 * its expiration ledger can no longer open anything, so each one either opened
 * a position or never will: 'opened' if the contract holds a position on those
 * terms that no other reservation already accounts for, 'unused' otherwise.
 *
 * If the chain cannot be read they stay pending, and pending counts — an
 * allowance that cannot be checked is not handed back.
 */
async function resolveLapsed(input: PolicyInput): Promise<void> {
  if (!input.readPositions) return
  const pool = getPool()
  const lapsed = await pool.query(
    `select id, subtype, collateral::float8 as collateral, strike_price, expiry_iso
       from quote_reservations
      where address = $1 and underlying = $2
        and state = 'pending' and valid_until < now()
      order by id`,
    [input.address, input.underlying]
  )
  if (!lapsed.rows?.length) return

  let positions: OnChainPosition[]
  try {
    positions = await input.readPositions()
  } catch (err) {
    console.warn('quote-policy: positions unreadable, lapsed reservations kept', err)
    return
  }

  const available = new Map<string, number>()
  for (const p of positions) {
    const k = termsKey(p.side, p.collateral, p.strike, p.expiry.getTime())
    available.set(k, (available.get(k) ?? 0) + 1)
  }
  const claimed = await pool.query(
    `select subtype, collateral::float8 as collateral, strike_price, expiry_iso
       from quote_reservations
      where address = $1 and underlying = $2 and state in ('opened','indexed')`,
    [input.address, input.underlying]
  )
  for (const r of claimed.rows ?? []) {
    const k = termsKey(r.subtype, Number(r.collateral), Number(r.strike_price), Date.parse(r.expiry_iso))
    available.set(k, (available.get(k) ?? 0) - 1)
  }

  const opened: number[] = []
  const unused: number[] = []
  for (const r of lapsed.rows) {
    const k = termsKey(r.subtype, Number(r.collateral), Number(r.strike_price), Date.parse(r.expiry_iso))
    const left = available.get(k) ?? 0
    if (left > 0) {
      opened.push(Number(r.id))
      available.set(k, left - 1)
    } else {
      unused.push(Number(r.id))
    }
  }
  await pool.query(
    `update quote_reservations
        set state = case when id = any($1::bigint[]) then 'opened' else 'unused' end
      where id = any($2::bigint[]) and state = 'pending'`,
    [opened, [...opened, ...unused]]
  )
}

/**
 * Reserve what the quoter is about to sign. Called before the signature leaves
 * the server; if this write fails the signature must not be returned, or the
 * position it opens would count against nothing.
 */
export async function reserveQuote(input: {
  address: string
  underlying: string
  type: 'call' | 'put'
  collateralAmount: number
  notionalUsd: number
  strikePrice: number
  expiryIso: string
  validUntil: Date
}): Promise<void> {
  await ensureSchema()
  await getPool().query(
    `insert into quote_reservations
       (address, underlying, subtype, collateral, notional_usd, strike_price, expiry_iso, valid_until)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.address,
      input.underlying,
      input.type,
      input.collateralAmount,
      input.notionalUsd,
      input.strikePrice,
      input.expiryIso,
      input.validUntil.toISOString(),
    ]
  )
}

/**
 * Hand a reservation over to the deposit row that now counts the same
 * position, so it is not counted twice. Best effort: a miss leaves the
 * reservation counting, which overstates usage and never understates it.
 */
export async function markReservationIndexed(input: {
  address: string
  underlying: string
  type: 'call' | 'put'
  collateral: number
  strike: number
  expiry: Date
}): Promise<void> {
  try {
    const pool = getPool()
    const rows = await pool.query(
      `select id, collateral::float8 as collateral, strike_price, expiry_iso
         from quote_reservations
        where address = $1 and underlying = $2 and subtype = $3
          and state <> 'indexed'
        order by id`,
      [input.address, input.underlying, input.type]
    )
    const want = termsKey(input.type, input.collateral, input.strike, input.expiry.getTime())
    const hit = (rows.rows ?? []).find(
      (r: any) =>
        termsKey(input.type, Number(r.collateral), Number(r.strike_price), Date.parse(r.expiry_iso)) === want
    )
    if (!hit) return
    await pool.query(`update quote_reservations set state = 'indexed' where id = $1`, [hit.id])
  } catch (err) {
    console.error('quote-policy: reservation not handed to its deposit', err)
  }
}

/**
 * Throws `PolicyRejection` if the protocol should decline to quote. Any other
 * throw means the history could not be read — callers must fail closed, since
 * an allowance that cannot be checked has not been satisfied.
 */
export async function assertQuoteAllowed(input: PolicyInput): Promise<void> {
  await ensureSchema()
  const pool = getPool()
  await resolveLapsed(input)

  // Everything signed and not yet accounted for, in the same four measures
  // the deposit history is read in below.
  const lo = input.strikePrice * (1 - input.strikeBucketPct)
  const hi = input.strikePrice * (1 + input.strikeBucketPct)
  const dateKey = input.expiryIso.slice(0, 10)
  const reservedRes = await pool.query(
    `select
       coalesce(sum(notional_usd) filter (
         where address = $1 and signed_at > now() - interval '30 days'), 0)::float8 as user_notional,
       coalesce(sum(collateral) filter (
         where address = $1 and subtype = 'call' and left(expiry_iso, 10) = $3), 0)::float8 as epoch_call,
       coalesce(sum(collateral) filter (
         where address = $1 and subtype = 'put' and left(expiry_iso, 10) = $3), 0)::float8 as epoch_put,
       coalesce(sum(notional_usd) filter (
         where strike_price between $4 and $5 and signed_at > now() - interval '14 days'), 0)::float8 as strike_notional
     from quote_reservations
     where underlying = $2 and ${OUTSTANDING}`,
    [input.address, input.underlying, dateKey, lo, hi]
  )
  const reserved = reservedRes.rows?.[0] ?? {}

  // Per-wallet 30-day notional (USD), for this underlying's book.
  const userRes = await pool.query(
    `select coalesce(sum(amount), 0)::float as sum
       from transactions
      where address = $1
        and type = 'deposit'
        and subtype in ('call', 'put')
        and underlying = $2
        and created_at > now() - interval '30 days'`,
    [input.address, input.underlying]
  )
  const userNotional =
    parseFloat(userRes.rows[0]?.sum ?? '0') + Number(reserved.user_notional ?? 0)
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
  const epochRes = await pool.query(
    `select coalesce(sum(case when subtype = 'call'
                              then (metadata->>'collateralAmount')::float8 end), 0)::float8 as call_underlying,
            coalesce(sum(case when subtype = 'put'
                              then amount end), 0)::float8 as put_usd
       from transactions
      where type = 'deposit'
        and subtype in ('call', 'put')
        and address = $1
        and underlying = $3
        and metadata ? 'expiryIso'
        and left(metadata->>'expiryIso', 10) = $2`,
    [input.address, dateKey, input.underlying]
  )
  const used =
    input.type === 'call'
      ? Number(epochRes.rows[0]?.call_underlying ?? 0) + Number(reserved.epoch_call ?? 0)
      : Number(epochRes.rows[0]?.put_usd ?? 0) + Number(reserved.epoch_put ?? 0)
  const limit =
    input.type === 'call' ? input.maxUserEpochCallXlm : input.maxUserEpochPutUsd
  if (used + input.collateralAmount > limit) {
    const remaining = Math.max(0, limit - used)
    // A call's allowance is counted in the underlying it escrows, a put's in
    // the cash it locks.
    const unit = input.type === 'call' ? input.underlying : 'USD'
    throw new PolicyRejection(
      `per-wallet limit for this expiry exceeded — you have used ${used.toFixed(0)} of ${limit.toFixed(0)} ${unit} (${remaining.toFixed(0)} ${unit} remaining). Other expiries have a fresh allowance.`,
      'user_epoch_limit_exceeded'
    )
  }

  // Per-strike 14-day inventory (USD), global across wallets. Stops the whole
  // book's short delta concentrating on one price point.
  const strikeRes = await pool.query(
    `select coalesce(sum(amount), 0)::float as sum
       from transactions
      where type = 'deposit'
        and subtype in ('call', 'put')
        and underlying = $3
        and metadata ? 'strikePrice'
        and (metadata->>'strikePrice')::float8 between $1 and $2
        and created_at > now() - interval '14 days'`,
    [lo, hi, input.underlying]
  )
  const strikeNotional =
    parseFloat(strikeRes.rows[0]?.sum ?? '0') + Number(reserved.strike_notional ?? 0)
  if (strikeNotional + input.notionalUsd > input.strikeInventoryLimitUsd) {
    throw new PolicyRejection(
      `strike $${input.strikePrice.toFixed(4)} is full — $${strikeNotional.toFixed(0)} of $${input.strikeInventoryLimitUsd} already sold against this strike. Pick a different strike.`,
      'strike_limit_exceeded'
    )
  }
}
