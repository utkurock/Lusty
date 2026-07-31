import { expiryLabel } from './expiries'
import { coveredUnits, type OptionSide } from './vault-contract'
import { quoteOption } from './pricing-server'

// Portfolio aggregation — pure, so it can be tested without a chain or a feed.
// ============================================================================
// The route above this fetches positions and market data; everything that turns
// them into risk numbers lives here.
//
// SIGN. Everything returned describes the WRITER. The pricing engine returns
// the option's Greeks from the holder's side (pricing.ts), so they are negated
// exactly once — in `legGreeks` — and that is the only place in the codebase
// where the flip happens. A wallet that has sold calls carries negative delta.
//
// COLLATERAL DOES NOT ADD UP. Calls escrow XLM, puts escrow cash. Different
// tokens, so they stay in separate fields and there is deliberately no total.
// One number across both would be a currency error dressed as a summary.
// Premiums are all cash, so those do sum.

/** One position, normalised away from whichever source produced it. */
export interface Leg {
  side: OptionSide
  collateral: number
  strike: number
  expiry: Date
  premium: number
  settled: boolean
}

/** The live inputs pricing needs. One observation serves the whole book. */
export interface PortfolioMarket {
  spot: number
  sigmaRealized: number
  /** Perp funding, annualised. Carries the forward out to each expiry. */
  fundingAnnual: number
}

export interface ExpiryBucket {
  expiryIso: string
  expiryLabel: string
  daysToExpiry: number
  positions: number
  /** XLM locked behind calls at this expiry. */
  callCollateralXlm: number
  /** Cash locked behind puts at this expiry, in USD. */
  putCollateralUsd: number
  premiumUsd: number
  /** Writer's delta in underlying units. Null when nothing here was priced. */
  netDelta: number | null
  /** Writer's vega, USD per 1.00 of σ. Null when nothing here was priced. */
  netVega: number | null
  /** Past expiry, not yet settled — no remaining market sensitivity. */
  awaitingSettlement: number
}

export interface PortfolioSummary {
  counts: { open: number; awaitingSettlement: number; settled: number }
  /** Locked right now. Settled positions hold nothing and are not counted. */
  collateral: { callXlm: number; putUsd: number }
  /**
   * Lifetime premium income, settled positions included — it was earned and
   * paid at open, and settling does not take it back. `byExpiry` buckets only
   * positions that are still live, so its premiums sum to LESS than this once
   * anything has settled. The two answer different questions on purpose.
   */
  premiumUsd: number
  greeks: {
    basis: 'writer'
    netDelta: number
    netVega: number
    pricedPositions: number
  } | null
  byExpiry: ExpiryBucket[]
}

export function daysUntil(expiry: Date, now: number = Date.now()): number {
  return (expiry.getTime() - now) / 86_400_000
}

/**
 * The writer's Greeks for one position, in underlying units and USD-per-σ.
 *
 * The numbers come out of `quoteOption` rather than being recomputed from
 * Black-76 here, and that is the point: the criterion is that portfolio risk
 * matches the pricing engine's own output, and the only way to guarantee it is
 * to ask the engine. Its APR fields depend on utilization and the time
 * reference; delta and vega do not, so those defaults go unused.
 *
 * The forward is carried out to this expiry from one funding observation
 * (F = S·exp(funding·T)) — the same arithmetic `getForward` does internally,
 * so a twelve-position book costs one market fetch rather than twelve.
 */
export function legGreeks(
  leg: Leg,
  market: PortfolioMarket,
  now: number = Date.now()
): { delta: number; vega: number } {
  const daysToExpiry = daysUntil(leg.expiry, now)
  const timeYears = daysToExpiry / 365
  const forward = market.spot * Math.exp(market.fundingAnnual * timeYears)

  const quote = quoteOption({
    side: leg.side,
    spot: market.spot,
    forward,
    strike: leg.strike,
    daysToExpiry,
    sigmaRealized: market.sigmaRealized,
  })

  const units = coveredUnits(leg.side, leg.collateral, leg.strike)
  // Negated here and nowhere else: the engine prices the option, the wallet
  // sold it.
  return { delta: -quote.delta * units, vega: -quote.vega * units }
}

export function aggregatePortfolio(
  legs: Leg[],
  market: PortfolioMarket | null,
  now: number = Date.now()
): PortfolioSummary {
  const buckets = new Map<string, ExpiryBucket>()
  let callCollateralXlm = 0
  let putCollateralUsd = 0
  let premiumUsd = 0
  let netDelta = 0
  let netVega = 0
  let priced = 0
  let open = 0
  let awaitingSettlement = 0
  let settled = 0

  for (const leg of legs) {
    if (leg.settled) {
      settled++
      // A settled position has paid out and holds nothing. Its premium stays
      // in the income total — it was earned — but it locks no collateral and
      // carries no risk, so it contributes to neither.
      premiumUsd += leg.premium
      continue
    }

    const daysToExpiry = daysUntil(leg.expiry, now)
    const expired = daysToExpiry <= 0
    if (expired) awaitingSettlement++
    else open++

    const key = leg.expiry.toISOString()
    const bucket = buckets.get(key) ?? {
      expiryIso: key,
      expiryLabel: expiryLabel(leg.expiry),
      daysToExpiry: Math.max(0, daysToExpiry),
      positions: 0,
      callCollateralXlm: 0,
      putCollateralUsd: 0,
      premiumUsd: 0,
      netDelta: null,
      netVega: null,
      awaitingSettlement: 0,
    }
    buckets.set(key, bucket)

    bucket.positions++
    if (expired) bucket.awaitingSettlement++
    bucket.premiumUsd += leg.premium
    premiumUsd += leg.premium

    if (leg.side === 'call') {
      bucket.callCollateralXlm += leg.collateral
      callCollateralXlm += leg.collateral
    } else {
      bucket.putCollateralUsd += leg.collateral
      putCollateralUsd += leg.collateral
    }

    // Past expiry the settlement price is already pinned to the oracle's
    // reading at that timestamp, so the position has no sensitivity left to
    // anything the market does now. Zero here is a fact, not a gap.
    if (expired || !market) continue

    try {
      const g = legGreeks(leg, market, now)
      bucket.netDelta = (bucket.netDelta ?? 0) + g.delta
      bucket.netVega = (bucket.netVega ?? 0) + g.vega
      netDelta += g.delta
      netVega += g.vega
      priced++
    } catch (err) {
      // One unpriceable position must not blank the rest of the book.
      console.warn('portfolio: could not price a position', err)
    }
  }

  return {
    counts: { open, awaitingSettlement, settled },
    collateral: { callXlm: callCollateralXlm, putUsd: putCollateralUsd },
    premiumUsd,
    greeks:
      market && priced > 0
        ? { basis: 'writer', netDelta, netVega, pricedPositions: priced }
        : null,
    byExpiry: [...buckets.values()].sort((a, b) =>
      a.expiryIso.localeCompare(b.expiryIso)
    ),
  }
}
