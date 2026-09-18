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

import { LUSD_CODE, LUSD_ISSUER, LUSD_DISTRIBUTOR } from './lusd'

export type SwapDirection = 'xlm_to_lusd' | 'lusd_to_xlm'

/** The fields of a Horizon transaction record this check reads. */
export interface ProofTransaction {
  successful?: boolean
  source_account?: string
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
  // would be paid out in XLM at the LUSD rate. Nothing but LUSD can reach the
  // account today, because a payment needs a trustline and it holds one — but
  // that is a property of the account this morning, not a check, and the day it
  // opens a second trustline the hole opens with it.
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
