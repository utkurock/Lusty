// The rate a written position actually paid.
// ------------------------------------------
// The quote engine publishes an APR at deposit time and the contract has
// nowhere to put it, so for most of this vault's life the dashboard had no APR
// to show and printed 0.00% — a real number, in the place a real number goes,
// for a position that had paid a perfectly good premium.
//
// The fix is not to trust the client's figure but to recompute it, because
// everything it takes is either on chain or a matter of public record:
//
//   APR = premium / capital · 365/days · 100
//
// which is lib/pricing-server's own definition, with its own capital: the
// underlying's value at open for a call, the escrowed cash for a put. Nothing
// here reprices anything — the premium is the one the contract paid.

import type { OptionSide } from './vault-contract'

export interface AprInputs {
  side: OptionSide
  /** Escrowed collateral: XLM for a call, cash for a put. */
  collateral: number
  /** Cash premium the contract paid at open. */
  premium: number
  openedAt: number
  expiry: number
  /**
   * XLM/USD when the position was written. Required for a call, where the
   * capital at risk is the underlying; ignored for a put, whose collateral is
   * already cash.
   */
  spotAtOpen?: number | null
}

/**
 * Annualized premium yield, or null when it cannot be computed honestly.
 *
 * Null rather than zero, every time. The two are indistinguishable on screen
 * and mean opposite things: one says the rate is not known here, the other
 * says the writer earned nothing.
 */
export function realizedApr(input: AprInputs): number | null {
  const { side, collateral, premium, openedAt, expiry } = input
  if (!(collateral > 0) || !(premium > 0)) return null

  const days = (expiry - openedAt) / 86_400_000
  // A term of zero would divide by zero, and a negative one means the two
  // timestamps came from sources that disagree. Neither is an APR.
  if (!(days > 0) || !isFinite(days)) return null

  const capital =
    side === 'put'
      ? collateral
      : input.spotAtOpen && input.spotAtOpen > 0
        ? collateral * input.spotAtOpen
        : 0
  if (!(capital > 0)) return null

  const apr = (premium / capital) * (365 / days) * 100
  return isFinite(apr) ? apr : null
}
