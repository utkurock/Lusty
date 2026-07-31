import { describe, it, expect } from 'vitest'
import {
  aggregatePortfolio,
  legGreeks,
  daysUntil,
  type Leg,
  type PortfolioMarket,
} from '../portfolio'
import { quoteOption } from '../pricing-server'
import { coveredUnits } from '../vault-contract'

// A fixed clock: expiries are stated relative to it so the tests do not drift.
const NOW = Date.parse('2026-07-31T12:00:00Z')
const day = 86_400_000

const MARKET: PortfolioMarket = {
  spot: 0.23,
  sigmaRealized: 0.9,
  fundingAnnual: 0.05,
}

function leg(over: Partial<Leg> = {}): Leg {
  return {
    side: 'call',
    collateral: 1000,
    strike: 0.25,
    expiry: new Date(NOW + 7 * day),
    premium: 4,
    settled: false,
    ...over,
  }
}

describe('daysUntil', () => {
  it('measures against the clock it is given', () => {
    expect(daysUntil(new Date(NOW + 7 * day), NOW)).toBeCloseTo(7, 10)
    expect(daysUntil(new Date(NOW - 2 * day), NOW)).toBeCloseTo(-2, 10)
  })
})

describe('legGreeks', () => {
  it('flips the sign: the engine prices the option, the wallet sold it', () => {
    const call = leg()
    const g = legGreeks(call, MARKET, NOW)
    const quote = quoteOption({
      side: 'call',
      spot: MARKET.spot,
      forward: MARKET.spot * Math.exp(MARKET.fundingAnnual * (7 / 365)),
      strike: call.strike,
      daysToExpiry: 7,
      sigmaRealized: MARKET.sigmaRealized,
    })
    const units = coveredUnits('call', call.collateral, call.strike)

    expect(quote.delta).toBeGreaterThan(0)
    expect(g.delta).toBeCloseTo(-quote.delta * units, 10)
    expect(g.vega).toBeCloseTo(-quote.vega * units, 10)
  })

  it('leaves a short call negative delta and a short put positive', () => {
    expect(legGreeks(leg(), MARKET, NOW).delta).toBeLessThan(0)
    const put = leg({ side: 'put', collateral: 200, strike: 0.21 })
    expect(legGreeks(put, MARKET, NOW).delta).toBeGreaterThan(0)
  })

  it('is short vega on both legs — the writer loses when vol rises', () => {
    expect(legGreeks(leg(), MARKET, NOW).vega).toBeLessThan(0)
    expect(legGreeks(leg({ side: 'put', strike: 0.21 }), MARKET, NOW).vega).toBeLessThan(0)
  })

  it('scales with the units covered, not with the collateral', () => {
    // A put escrows cash; what it is short is the underlying that cash buys at
    // the strike. Double the collateral, double the exposure either way.
    const one = legGreeks(leg({ side: 'put', collateral: 200, strike: 0.20 }), MARKET, NOW)
    const two = legGreeks(leg({ side: 'put', collateral: 400, strike: 0.20 }), MARKET, NOW)
    expect(two.delta).toBeCloseTo(one.delta * 2, 10)
    expect(coveredUnits('put', 200, 0.2)).toBeCloseTo(1000, 10)
  })
})

describe('aggregatePortfolio', () => {
  it('returns a valid zero-filled summary for an empty book', () => {
    const s = aggregatePortfolio([], MARKET, NOW)
    expect(s.counts).toEqual({ open: 0, awaitingSettlement: 0, settled: 0 })
    expect(s.collateral).toEqual({ callXlm: 0, putUsd: 0 })
    expect(s.premiumUsd).toBe(0)
    expect(s.byExpiry).toEqual([])
    expect(s.greeks).toBeNull()
  })

  it('keeps call and put collateral apart — different tokens do not sum', () => {
    const s = aggregatePortfolio(
      [
        leg({ side: 'call', collateral: 1000 }),
        leg({ side: 'put', collateral: 250, strike: 0.21 }),
      ],
      MARKET,
      NOW
    )
    expect(s.collateral.callXlm).toBeCloseTo(1000, 10)
    expect(s.collateral.putUsd).toBeCloseTo(250, 10)
    expect(s).not.toHaveProperty('collateral.total')
  })

  it('nets delta across opposing legs', () => {
    const call = leg({ side: 'call', collateral: 1000, strike: 0.25 })
    const put = leg({ side: 'put', collateral: 250, strike: 0.21 })
    const s = aggregatePortfolio([call, put], MARKET, NOW)
    const expected =
      legGreeks(call, MARKET, NOW).delta + legGreeks(put, MARKET, NOW).delta
    expect(s.greeks!.netDelta).toBeCloseTo(expected, 10)
    expect(s.greeks!.pricedPositions).toBe(2)
    expect(s.greeks!.basis).toBe('writer')
  })

  it('sums vega with the same sign on both legs', () => {
    const s = aggregatePortfolio(
      [leg({ side: 'call' }), leg({ side: 'put', strike: 0.21 })],
      MARKET,
      NOW
    )
    // Short both, so the two contributions reinforce rather than cancel.
    expect(s.greeks!.netVega).toBeLessThan(legGreeks(leg(), MARKET, NOW).vega)
  })

  it('counts a settled position\'s premium but none of its risk', () => {
    const s = aggregatePortfolio(
      [leg({ settled: true, premium: 4, collateral: 1000 })],
      MARKET,
      NOW
    )
    expect(s.counts.settled).toBe(1)
    expect(s.premiumUsd).toBeCloseTo(4, 10)
    expect(s.collateral.callXlm).toBe(0)
    expect(s.greeks).toBeNull()
    expect(s.byExpiry).toEqual([])
  })

  it('holds expired-but-unsettled collateral while pricing no risk against it', () => {
    // The settlement price was pinned by the oracle at expiry, so nothing the
    // market does now can move this position.
    const s = aggregatePortfolio(
      [leg({ expiry: new Date(NOW - day), collateral: 500 })],
      MARKET,
      NOW
    )
    expect(s.counts).toEqual({ open: 0, awaitingSettlement: 1, settled: 0 })
    expect(s.collateral.callXlm).toBeCloseTo(500, 10)
    expect(s.greeks).toBeNull()
    expect(s.byExpiry[0].awaitingSettlement).toBe(1)
    expect(s.byExpiry[0].netDelta).toBeNull()
    expect(s.byExpiry[0].daysToExpiry).toBe(0)
  })

  it('buckets by expiry, in chronological order', () => {
    const near = new Date(NOW + 3 * day)
    const far = new Date(NOW + 21 * day)
    const s = aggregatePortfolio(
      [
        leg({ expiry: far, collateral: 100 }),
        leg({ expiry: near, collateral: 200 }),
        leg({ expiry: near, collateral: 300, side: 'put', strike: 0.21 }),
      ],
      MARKET,
      NOW
    )
    expect(s.byExpiry).toHaveLength(2)
    expect(s.byExpiry[0].expiryIso).toBe(near.toISOString())
    expect(s.byExpiry[1].expiryIso).toBe(far.toISOString())
    expect(s.byExpiry[0].positions).toBe(2)
    expect(s.byExpiry[0].callCollateralXlm).toBeCloseTo(200, 10)
    expect(s.byExpiry[0].putCollateralUsd).toBeCloseTo(300, 10)
    expect(s.byExpiry[1].callCollateralXlm).toBeCloseTo(100, 10)
  })

  it('bucket totals reconcile with the portfolio totals', () => {
    const legs = [
      leg({ expiry: new Date(NOW + 3 * day), collateral: 100, premium: 1 }),
      leg({ expiry: new Date(NOW + 10 * day), collateral: 200, premium: 2 }),
      leg({
        expiry: new Date(NOW + 10 * day),
        collateral: 300,
        premium: 3,
        side: 'put',
        strike: 0.21,
      }),
    ]
    const s = aggregatePortfolio(legs, MARKET, NOW)
    const sum = (f: (b: (typeof s.byExpiry)[number]) => number) =>
      s.byExpiry.reduce((acc, b) => acc + f(b), 0)

    expect(sum((b) => b.callCollateralXlm)).toBeCloseTo(s.collateral.callXlm, 10)
    expect(sum((b) => b.putCollateralUsd)).toBeCloseTo(s.collateral.putUsd, 10)
    expect(sum((b) => b.premiumUsd)).toBeCloseTo(s.premiumUsd, 10)
    expect(sum((b) => b.netDelta ?? 0)).toBeCloseTo(s.greeks!.netDelta, 10)
    expect(sum((b) => b.netVega ?? 0)).toBeCloseTo(s.greeks!.netVega, 10)
  })

  it('counts settled premium as income but keeps it out of the expiry buckets', () => {
    // The two totals answer different questions: income is lifetime, buckets
    // describe what is still live. A reader summing buckets must not expect
    // the income figure back.
    const s = aggregatePortfolio(
      [
        leg({ settled: true, premium: 10 }),
        leg({ expiry: new Date(NOW + 3 * day), premium: 4 }),
      ],
      MARKET,
      NOW
    )
    expect(s.premiumUsd).toBeCloseTo(14, 10)
    expect(s.byExpiry).toHaveLength(1)
    expect(s.byExpiry[0].premiumUsd).toBeCloseTo(4, 10)
  })

  it('reports position facts with no market data, and no Greeks', () => {
    const s = aggregatePortfolio([leg({ collateral: 1000, premium: 4 })], null, NOW)
    expect(s.counts.open).toBe(1)
    expect(s.collateral.callXlm).toBeCloseTo(1000, 10)
    expect(s.premiumUsd).toBeCloseTo(4, 10)
    expect(s.greeks).toBeNull()
    expect(s.byExpiry[0].netDelta).toBeNull()
    expect(s.byExpiry[0].netVega).toBeNull()
  })

  it('keeps the rest of the book when one position cannot be priced', () => {
    const good = leg({ collateral: 1000 })
    // A zero strike is unpriceable: quoteOption rejects it and coveredUnits
    // would divide by it. It must cost its own Greeks and nothing else.
    const bad = leg({ collateral: 500, strike: 0 })
    const s = aggregatePortfolio([good, bad], MARKET, NOW)

    expect(s.counts.open).toBe(2)
    expect(s.collateral.callXlm).toBeCloseTo(1500, 10)
    expect(s.greeks!.pricedPositions).toBe(1)
    expect(s.greeks!.netDelta).toBeCloseTo(legGreeks(good, MARKET, NOW).delta, 10)
  })
})
