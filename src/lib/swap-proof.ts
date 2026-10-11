// What counts as proof that a swap was funded.
// ============================================
// The swap route pays out of the distributor against a payment the caller says
// they made. Everything that decides whether that payment happened lives here,
// as one pure function over two Horizon records, because it is the only thing
// standing between an account holding real balances and anybody with a hash.
//
// The rule it enforces, stated once: a payment is proof when the transaction
// SUCCEEDED, was sent by the address claiming it, paid the distributor, in the
// asset the direction names, in the amount claimed. Any one of those missing
// and there is no proof — not a smaller payout, no payout.

import { Keypair } from '@stellar/stellar-sdk'
import { LUSD_CODE, LUSD_ISSUER, LUSD_DISTRIBUTOR } from './lusd'

export type SwapDirection = 'xlm_to_lusd' | 'lusd_to_xlm'

/** The fields of a Horizon transaction record this check reads. */
export interface ProofTransaction {
  /** The transaction's own hash, lowercase hex. */
  hash?: string
  successful?: boolean
  source_account?: string
  /** When the ledger closed the transaction, ISO 8601. */
  created_at?: string
  /** Present only on a fee-bumped transaction. */
  fee_bump_transaction?: { hash?: string }
  /** Present only on a fee-bumped transaction. */
  inner_transaction?: { hash?: string }
}

/** The fields of a Horizon operation record this check reads. */
export interface ProofOperation {
  type?: string
  to?: string
  amount?: string
  asset_type?: string
  asset_code?: string
  asset_issuer?: string
  transaction_successful?: boolean
}

export interface ProofRejection {
  error: string
  status: number
  code: string
}

/**
 * Refuse a fee-bumped funding transaction.
 *
 * A fee bump has two hashes, the outer envelope's and the inner transaction's,
 * and Horizon answers to both with the same record: same success, same source,
 * same payment. The replay guard is keyed on the hash the caller posts, so a
 * fee-bumped payment could be claimed once under each hash and paid twice.
 * Nothing this site builds is fee-bumped, so the envelope is refused rather
 * than reconciled — which also covers rows reserved under either hash before
 * this check existed.
 */
export function feeBumpRejection(tx: ProofTransaction): ProofRejection | null {
  if (tx.fee_bump_transaction || tx.inner_transaction) {
    return {
      error: 'fee-bumped payments are not accepted; send the payment as a plain transaction',
      status: 400,
      code: 'fee_bump',
    }
  }
  return null
}

/**
 * A funding hash in the one spelling the replay guard keys on, or null.
 *
 * The guard is keyed on the hash the caller posts, but the payout is
 * authorized by whatever record Horizon returns for it — and the SDK puts the
 * posted string into a URL path, where './H', 'x/../H' and '%2e/H' all resolve
 * to /transactions/H. Each of those spellings was a new key for one payment,
 * so each was paid. A transaction hash is 64 hex characters; anything else is
 * refused before Horizon is asked, and case is folded so 'H' and its uppercase
 * are one key. The route then also requires the record's own hash to match.
 */
export function canonicalFundingHash(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const hash = raw.trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null
}

/**
 * Why the distributor key cannot pay out here, or null when it can.
 *
 * The proof accepts payments made TO the advertised distributor address; the
 * payout is signed by whatever account LUSD_DISTRIBUTOR_SECRET holds. If the
 * two drift apart — a rotated key, a copy-pasted env — users fund one account
 * and the other pays, so neither balance means what the checks assume. Refuse
 * rather than guess which one is right.
 */
export function distributorMismatch(secret: string): string | null {
  let signer: string
  try {
    signer = Keypair.fromSecret(secret).publicKey()
  } catch {
    return 'the distributor secret is not a valid Stellar secret key'
  }
  return signer === LUSD_DISTRIBUTOR
    ? null
    : 'the distributor secret does not belong to the advertised distributor address'
}

/**
 * How old a funding payment may be when it is claimed. A payment that could be
 * claimed whenever its sender liked would be a free option on the price: pay
 * now, keep the hash, claim once the market moved the right way. The swap now
 * also prices at the worse of the funding-time and the claim-time rate, which
 * takes the upside out of waiting; this bound keeps the window short anyway. A
 * wallet claims seconds after paying; this leaves room for a retry and none for
 * waiting on the market. The bridge has no price, but applies the same bound so
 * an old payment cannot be re-presented indefinitely.
 */
export const FUNDING_MAX_AGE_MS = 15 * 60_000

/** Tolerance on the claimed amount, in units of the asset paid. */
export const AMOUNT_EPSILON = 0.01

/**
 * Verify a funding payment, or say why it is not one.
 *
 * Returns the amount actually paid on success — the payout is sized from the
 * ledger's number, never from the caller's.
 */
export function verifyFunding(input: {
  tx: ProofTransaction | null
  operations: ProofOperation[]
  direction: SwapDirection
  address: string
  sourceAmount: number
  /** Refuse a payment older than this. Omitted, age is not checked. */
  maxAgeMs?: number
  now?: number
}): ProofRejection | { ok: true; paidAmount: number } {
  const { tx, operations, direction, address, sourceAmount } = input

  if (!tx) {
    return {
      error: 'payment transaction not found on Horizon',
      status: 404,
      code: 'tx_not_found',
    }
  }

  // A transaction that FAILED is still a transaction: it is included in a
  // ledger, it keeps its hash, and Horizon ingests it. Worse, its operations
  // come back from `/transactions/{hash}/operations` without `include_failed`,
  // payment records and all — so the destination, the asset and the amount all
  // read exactly as they would on a payment that moved money, because they are
  // fields of an operation that was submitted and rejected.
  //
  // Left unchecked this route is a faucet: submit an underfunded payment of
  // 100,000 LUSD to the distributor for a few hundred stroops, post the hash,
  // and the distributor pays XLM against it. The replay ledger does not help,
  // because each failed submission is a new hash.
  if (tx.successful !== true) {
    return {
      error: 'that transaction did not succeed, so nothing was paid',
      status: 400,
      code: 'tx_failed',
    }
  }

  const bumped = feeBumpRejection(tx)
  if (bumped) return bumped

  if (input.maxAgeMs !== undefined) {
    const closedAt = Date.parse(tx.created_at ?? '')
    const age = (input.now ?? Date.now()) - closedAt
    if (!isFinite(closedAt) || age > input.maxAgeMs) {
      return {
        error:
          'that payment is too old to swap at today s price — contact support to have it returned',
        status: 400,
        code: 'funding_stale',
      }
    }
  }

  if (tx.source_account !== address) {
    return {
      error: 'tx source does not match claimed address',
      status: 403,
      code: 'source_mismatch',
    }
  }

  const payment = operations.find((o) => o.type === 'payment')
  if (!payment || payment.to !== LUSD_DISTRIBUTOR) {
    return {
      error: 'tx does not pay the distributor',
      status: 400,
      code: 'not_to_distributor',
    }
  }

  // The same fact from the other endpoint. The two are ingested separately and
  // only one of them was ever consulted.
  if (payment.transaction_successful === false) {
    return {
      error: 'that payment did not succeed, so nothing was paid',
      status: 400,
      code: 'payment_failed',
    }
  }

  // Both directions name the asset exactly. "Not native" is not the same claim
  // as "is LUSD": any issued asset the distributor can hold satisfies it, and
  // would be paid out in XLM at the LUSD rate. That day has arrived — the
  // distributor now also holds the anchor's asset, for the bridge in
  // app/api/anchor/bridge — so the exact code and issuer below are what keeps a
  // payment in the wrong dollar from being swapped for XLM.
  const paidNative = payment.asset_type === 'native'
  const paidLusd =
    !paidNative &&
    payment.asset_code === LUSD_CODE &&
    payment.asset_issuer === LUSD_ISSUER

  if (direction === 'xlm_to_lusd' && !paidNative) {
    return {
      error: 'expected XLM payment for xlm_to_lusd swap',
      status: 400,
      code: 'wrong_asset',
    }
  }
  if (direction === 'lusd_to_xlm' && !paidLusd) {
    return {
      error: `expected ${LUSD_CODE} payment for lusd_to_xlm swap`,
      status: 400,
      code: 'wrong_asset',
    }
  }

  const paidAmount = parseFloat(String(payment.amount))
  if (!isFinite(paidAmount) || paidAmount <= 0) {
    return {
      error: 'payment carries no readable amount',
      status: 400,
      code: 'amount_unreadable',
    }
  }
  if (Math.abs(paidAmount - sourceAmount) > AMOUNT_EPSILON) {
    return {
      error: `paid amount ${paidAmount} does not match claim ${sourceAmount}`,
      status: 400,
      code: 'amount_mismatch',
    }
  }

  return { ok: true, paidAmount }
}
