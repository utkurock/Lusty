// What counts as proof that a bridge crossing was funded.
// ======================================================
// The bridge route pays out of the same distributor the swap route spends, so
// it is held to the same rule, stated once: a payment is proof when the
// transaction SUCCEEDED, was sent by the address claiming it, paid the
// distributor, in exactly the asset the direction names, in the amount claimed.
//
// The one thing this adds over lib/swap-proof is which assets it names. The
// swap trades XLM against LUSD; the bridge trades the anchor's asset against
// LUSD, and it names that asset by code AND issuer. The distributor now holds
// two issued trustlines, so "an issued asset arrived" is no longer a statement
// about which one.

import { LUSD_CODE, LUSD_ISSUER, LUSD_DISTRIBUTOR } from '@/lib/lusd'
import { ANCHOR_ASSET_CODE, ANCHOR_ASSET_ISSUER } from './config'
import type { ProofOperation, ProofRejection, ProofTransaction } from '@/lib/swap-proof'
import { AMOUNT_EPSILON } from '@/lib/swap-proof'

export type BridgeDirection = 'anchor_to_cash' | 'cash_to_anchor'

/** Which asset each direction is funded in, and which it pays out. */
export function legsOf(direction: BridgeDirection) {
  const anchor = { code: ANCHOR_ASSET_CODE, issuer: ANCHOR_ASSET_ISSUER }
  const cash = { code: LUSD_CODE, issuer: LUSD_ISSUER }
  return direction === 'anchor_to_cash'
    ? { pays: anchor, receives: cash }
    : { pays: cash, receives: anchor }
}

export function isBridgeDirection(value: unknown): value is BridgeDirection {
  return value === 'anchor_to_cash' || value === 'cash_to_anchor'
}

/**
 * Verify a funding payment, or say why it is not one.
 *
 * Returns the amount the ledger recorded. The payout is sized from that number
 * and never from the caller's, which is the only reason the claimed amount is
 * allowed to be wrong at all.
 */
export function verifyBridgeFunding(input: {
  tx: ProofTransaction | null
  operations: ProofOperation[]
  direction: BridgeDirection
  address: string
  sourceAmount: number
}): ProofRejection | { ok: true; paidAmount: number } {
  const { tx, operations, direction, address, sourceAmount } = input
  const { pays } = legsOf(direction)

  if (!tx) {
    return { error: 'payment transaction not found on Horizon', status: 404, code: 'tx_not_found' }
  }

  // A failed transaction keeps its hash and its operation records: destination,
  // asset and amount all read as they would on a payment that moved money,
  // because they are fields of an operation that was submitted and rejected.
  if (tx.successful !== true) {
    return {
      error: 'that transaction did not succeed, so nothing was paid',
      status: 400,
      code: 'tx_failed',
    }
  }

  if (tx.source_account !== address) {
    return { error: 'tx source does not match claimed address', status: 403, code: 'source_mismatch' }
  }

  const payment = operations.find(o => o.type === 'payment')
  if (!payment || payment.to !== LUSD_DISTRIBUTOR) {
    return { error: 'tx does not pay the distributor', status: 400, code: 'not_to_distributor' }
  }

  if (payment.transaction_successful === false) {
    return {
      error: 'that payment did not succeed, so nothing was paid',
      status: 400,
      code: 'payment_failed',
    }
  }

  // Both bridge legs are issued assets, so both are named in full. Neither is
  // native, and "not native" would not distinguish them from each other.
  const matches =
    payment.asset_type !== 'native' &&
    payment.asset_code === pays.code &&
    payment.asset_issuer === pays.issuer

  if (!matches) {
    return {
      error: `expected a ${pays.code} payment for this direction`,
      status: 400,
      code: 'wrong_asset',
    }
  }

  const paidAmount = parseFloat(String(payment.amount))
  if (!isFinite(paidAmount) || paidAmount <= 0) {
    return { error: 'payment carries no readable amount', status: 400, code: 'amount_unreadable' }
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
