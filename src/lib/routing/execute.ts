// Executing a routed swap with a minimum output.
// =============================================
// The bound is enforced by the PROTOCOL, not by us. `PathPaymentStrictReceive`
// carries a `sendMax` and a `destAmount`, and the network either delivers
// exactly the destination amount for no more than the maximum or the operation
// fails and nothing moves. There is no partial fill and no window in which the
// money has left and the check has not run yet.
//
// That is the whole argument for decision 2. A checked-afterwards swap has a
// state where the send has happened and the receive is worse than quoted, and
// the only thing to do about it is write it down. This has no such state.
//
// So the job here is narrow and worth being strict about: turn a quote into a
// send maximum, refuse if anything about the quote no longer holds, and build
// the operation. The send maximum is derived HERE, from the route's own
// slippage allowance — never passed in. A caller that could name its own
// maximum could name one that fills at any price, which is the same as having
// no bound at all.

import { BASE_FEE, Horizon, Operation, TransactionBuilder } from '@stellar/stellar-sdk'
import { HORIZON_URL, NETWORK_PASSPHRASE } from '../stellar'
import { RouteRefused, isStale, toStellarAsset, type RouteQuote } from './quote'

/** Stellar carries seven decimals. More than that is not representable. */
const DECIMALS = 7
const BPS = 10_000

export interface RoutedSwap {
  quote: RouteQuote
  /** The most the writer can spend. Derived, never supplied. */
  sendMax: number
  /** Exactly what they receive. The protocol will not deliver less. */
  destAmount: number
  destination: string
}

/**
 * The most this quote may cost once the allowance is applied.
 *
 * Rounded UP to a representable amount: rounding a ceiling down would make it
 * tighter than the route declares, which fails trades the desk said it would
 * accept. Rounding a floor up would be the dangerous direction; this is not a
 * floor.
 */
export function sendMaxFor(quote: RouteQuote): number {
  const raw = quote.sendAmount * (1 + quote.route.maxSlippageBps / BPS)
  const step = 10 ** DECIMALS
  return Math.ceil(raw * step) / step
}

/**
 * How far the execution bound sits above the quote, in basis points.
 *
 * What the monitor records as realised slippage is measured against this after
 * the fact; this is the allowance going in.
 */
export function slippageBps(quote: RouteQuote, sendMax: number): number {
  if (!(quote.sendAmount > 0)) return 0
  return ((sendMax - quote.sendAmount) / quote.sendAmount) * BPS
}

/**
 * Turn a quote into a swap, or refuse.
 *
 * Every refusal here is a state in which sending would be worse than not
 * sending: a reading too old to stand behind, a cost that has grown past the
 * route's ceiling since it was quoted, or a bound that exceeds what the route
 * permits. None of them is recoverable by trying harder — the caller re-quotes
 * or does not trade.
 */
export function prepareSwap(
  quote: RouteQuote,
  destination: string,
  now: number = Date.now(),
): RoutedSwap {
  if (isStale(quote, now)) {
    throw new RouteRefused(
      `${quote.route.id}: the quote is ${Math.round((now - quote.quotedAt) / 1000)}s old, ` +
        `past the ${Math.round(quote.route.quoteMaxAgeMs / 1000)}s this route stands behind`,
      'unreachable',
    )
  }
  if (quote.destAmount > quote.route.maxNotional) {
    throw new RouteRefused(
      `${quote.route.id}: ${quote.destAmount} is above the ${quote.route.maxNotional} ceiling`,
      'above_notional',
    )
  }

  const sendMax = sendMaxFor(quote)
  // Belt and braces over the arithmetic above: the allowance is the only thing
  // that may widen the bound, and it is applied once.
  if (slippageBps(quote, sendMax) > quote.route.maxSlippageBps + 1e-6) {
    throw new RouteRefused(
      `${quote.route.id}: the send maximum is wider than the route's ${quote.route.maxSlippageBps} bps`,
      'path_not_allowed',
    )
  }

  return { quote, sendMax, destAmount: quote.destAmount, destination }
}

/**
 * The operation the swap is. One op, atomic, with both bounds in it.
 *
 * `path` is the intermediates the quote was taken over. It is not a suggestion:
 * the network uses exactly this path, which is why the allowlist check at quote
 * time is binding at execution time and not merely advisory.
 */
export function swapOperation(swap: RoutedSwap): xdrOperation {
  return Operation.pathPaymentStrictReceive({
    sendAsset: toStellarAsset(swap.quote.route.send),
    sendMax: swap.sendMax.toFixed(DECIMALS),
    destination: swap.destination,
    destAsset: toStellarAsset(swap.quote.route.receive),
    destAmount: swap.destAmount.toFixed(DECIMALS),
    path: swap.quote.hops.map(toStellarAsset),
  })
}

type xdrOperation = ReturnType<typeof Operation.pathPaymentStrictReceive>

/**
 * The transaction for the writer's wallet to sign.
 *
 * Built against their account, sent from their account, delivered to whoever
 * the swap names — this module never holds anything and never signs anything.
 * What it guarantees is the shape of what they are asked to sign.
 */
export async function buildSwapTx(
  swap: RoutedSwap,
  source: string,
): Promise<string> {
  const account = await new Horizon.Server(HORIZON_URL).loadAccount(source)
  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(swapOperation(swap))
    .setTimeout(120)
    .build()
    .toXDR()
}
