// What the testnet faucet will part with, and how often.
// =====================================================
// The faucet pays out of the same distributor account that pays premiums,
// seeds the DEX offers and funds settlements. A drained faucet is therefore
// not an inconvenience, it is a vault that cannot pay a writer — which is why
// the limits here are the asset's own rather than one number for everything.
//
// Three of them, each stopping something the others cannot:
//
//   cooldown     one claim per address per asset per day. The cheap bound, and
//                the one a person hits: it turns "click until rich" into
//                "come back tomorrow".
//   lifetimeMax  the same address, every drip it has ever taken. A cooldown
//                alone still hands out a fortune to a patient script.
//   dailyMax     everybody together. The only bound that survives address
//                farming, which neither of the first two can see.
//
// All three are counted from the `transactions` table, so they hold across
// serverless instances — the in-memory rate limiter in front of them does not.

import { LUSD_CODE, LUSD_ISSUER } from './lusd'
import { BTC } from './assets'

export const FAUCET_COOLDOWN_MS = 24 * 60 * 60 * 1000

export interface Drip {
  /** How it is logged and paid. */
  symbol: string
  code: string
  /** Null for native XLM, which comes from Friendbot rather than from us. */
  issuer: string | null
  /** Exactly what one claim pays, as a string so no float rounds it. */
  amount: string
  /** Most one address may ever take. */
  lifetimeMax: number
  /** Most the faucet pays out across everyone in a rolling day. */
  dailyMax: number
}

const num = (raw: string | undefined, fallback: number) => {
  const n = Number(raw)
  return isFinite(n) && n > 0 ? n : fallback
}

/**
 * The faucet's assets, by the name a URL can carry.
 *
 * LBTC is the tight one on purpose: the whole supply is a thousand units that
 * were minted once, the vault's own pool comes out of it, and a drip large
 * enough to matter to a tester is large enough to empty it in an afternoon.
 * 0.01 is ten times the minimum position the BTC book will write, which is
 * enough to open one and watch it settle.
 */
function registry(): Record<string, Drip> {
  const btc = BTC.stellarAsset
  return {
    XLM: {
      symbol: 'XLM',
      code: 'XLM',
      issuer: null,
      amount: '10000',
      // Friendbot funds an account once and refuses it afterwards; the caps
      // exist so the ledger of what this app handed out stays complete.
      lifetimeMax: num(process.env.FAUCET_ADDR_LIFETIME_MAX_XLM, 10_000),
      dailyMax: num(process.env.FAUCET_GLOBAL_DAILY_MAX_XLM, 1_000_000),
    },
    LUSD: {
      symbol: 'LUSD',
      code: LUSD_CODE,
      issuer: LUSD_ISSUER,
      amount: '1000',
      lifetimeMax: num(process.env.FAUCET_ADDR_LIFETIME_MAX, 10_000),
      dailyMax: num(process.env.FAUCET_GLOBAL_DAILY_MAX, 500_000),
    },
    LBTC: {
      symbol: btc.kind === 'issued' ? btc.code : 'LBTC',
      code: btc.kind === 'issued' ? btc.code : 'LBTC',
      issuer: btc.kind === 'issued' ? btc.issuer : null,
      amount: num(process.env.FAUCET_DRIP_BTC, 0.01).toString(),
      lifetimeMax: num(process.env.FAUCET_ADDR_LIFETIME_MAX_BTC, 0.05),
      dailyMax: num(process.env.FAUCET_GLOBAL_DAILY_MAX_BTC, 1),
    },
  }
}

/** The drip a URL segment names, or null. Null for an unconfigured asset. */
export function dripFor(raw: unknown): Drip | null {
  if (typeof raw !== 'string') return null
  const found = registry()[raw.trim().toUpperCase()]
  if (!found) return null
  // An issued asset with no issuer is not configured on this deployment, and
  // paying it would mean building a payment to nowhere.
  if (found.issuer === null && found.symbol !== 'XLM') return null
  return found
}

export class FaucetRejection extends Error {
  constructor(
    message: string,
    readonly code: 'cooldown' | 'lifetime_cap' | 'daily_cap',
    readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'FaucetRejection'
  }
}

// Rounded, and never below one: "try again in 0h" reads as "try again now",
// and the database clock runs far enough ahead of this process to make a
// just-written row look like it is from the future.
const hours = (ms: number) => Math.max(1, Math.round(ms / 3_600_000))

/**
 * Whether this address may take this drip now.
 *
 * Throws FaucetRejection when a limit binds, and any other error when the
 * ledger cannot be read — callers must fail closed on that, because a faucet
 * that pays out whenever its own bookkeeping is down has no limits at all.
 */
export async function assertDripAllowed(
  address: string,
  drip: Drip,
  now: Date = new Date(),
): Promise<void> {
  const { getPool, ensureSchema } = await import('./db')
  await ensureSchema()
  const pool = getPool()
  const amount = parseFloat(drip.amount)

  const last = await pool.query(
    `select max(created_at) as at
       from transactions
      where type = 'faucet' and address = $1 and asset = $2`,
    [address, drip.symbol],
  )
  const at = last.rows[0]?.at ? new Date(last.rows[0].at) : null
  if (at) {
    // Clamped: a row whose timestamp is ahead of this clock has waited zero,
    // not a negative amount, which would otherwise report 25 hours left on a
    // 24-hour cooldown.
    const waited = Math.max(0, now.getTime() - at.getTime())
    if (waited < FAUCET_COOLDOWN_MS) {
      const left = FAUCET_COOLDOWN_MS - waited
      throw new FaucetRejection(
        `One ${drip.symbol} claim a day — try again in ${hours(left)}h.`,
        'cooldown',
        Math.ceil(left / 1000),
      )
    }
  }

  const mine = await pool.query(
    `select coalesce(sum(amount), 0)::float as s
       from transactions
      where type = 'faucet' and address = $1 and asset = $2`,
    [address, drip.symbol],
  )
  if (parseFloat(mine.rows[0].s) + amount > drip.lifetimeMax) {
    throw new FaucetRejection(
      `This address has taken all the test ${drip.symbol} the faucet will give it.`,
      'lifetime_cap',
    )
  }

  const today = await pool.query(
    `select coalesce(sum(amount), 0)::float as s
       from transactions
      where type = 'faucet' and asset = $1 and created_at > now() - interval '1 day'`,
    [drip.symbol],
  )
  if (parseFloat(today.rows[0].s) + amount > drip.dailyMax) {
    throw new FaucetRejection(
      `The ${drip.symbol} faucet has given out its daily allowance — try again tomorrow.`,
      'daily_cap',
    )
  }
}
