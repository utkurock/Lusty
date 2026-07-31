import { describe, it, expect } from 'vitest'
import {
  quoteOption,
  offeredVol,
  utilizationTaper,
  type QuoteInput,
} from '../pricing-server'
import {
  roundStrike,
  CALL_STRIKE_MULTIPLIERS,
  PUT_STRIKE_MULTIPLIERS,
  black76Delta,
  black76Vega,
} from '../pricing'

// Defaults assumed by these tests (env unset in the test runner):
//   VOL_SPREAD_REL=0.10  VOL_SPREAD_ABS=0.03  MAX_PRICING_SIGMA=1.0
//   HAIRCUT_BASE=0.20    MAX_APR=120          PREMIUM_FEE_RATE=0.10
//   MAX_UTIL_DISCOUNT=0.50
const MAX_APR = 120
const FEE = 0.1
const TIME_REF = 21 // pinned explicitly for determinism

const SPOT = 0.23

function q(over: Partial<QuoteInput> = {}) {
  return quoteOption({
    side: 'call',
    spot: SPOT,
    strike: roundStrike(SPOT * 1.06, SPOT),
    daysToExpiry: 7,
    sigmaRealized: 0.9,
    utilization: 0,
    timeRefDays: TIME_REF,
    ...over,
  })
}

describe('offeredVol (vol risk premium)', () => {
  it('adds relative + absolute spread over realized', () => {
    expect(offeredVol(0.5)).toBeCloseTo(0.5 * 1.1 + 0.03, 10)
  })

  it('caps at the pricing sigma ceiling', () => {
    expect(offeredVol(1.6)).toBe(1.0)
  })
})

describe('utilizationTaper', () => {
  it('no discount on an empty pool, max discount on a full one', () => {
    expect(utilizationTaper(0)).toBe(1)
    expect(utilizationTaper(1)).toBeCloseTo(0.5, 10)
  })

  it('is monotone decreasing and clamps out-of-range inputs', () => {
    expect(utilizationTaper(0.25)).toBeGreaterThan(utilizationTaper(0.75))
    expect(utilizationTaper(-3)).toBe(1)
    expect(utilizationTaper(7)).toBeCloseTo(0.5, 10)
  })
})

describe('quoteOption — money-path invariants', () => {
  it('rejects invalid inputs (fail-closed)', () => {
    expect(() => q({ spot: 0 })).toThrow()
    expect(() => q({ spot: NaN })).toThrow()
    expect(() => q({ strike: -1 })).toThrow()
    expect(() => q({ daysToExpiry: 0 })).toThrow()
    expect(() => q({ sigmaRealized: 0 })).toThrow()
    // @ts-expect-error invalid side on purpose
    expect(() => q({ side: 'straddle' })).toThrow()
  })

  it('shown == paid: userPremium is exactly the displayed APR annuitized', () => {
    for (const side of ['call', 'put'] as const) {
      for (const days of [3, 7, 14, 21]) {
        const mult = side === 'call' ? 1.06 : 0.94
        const quote = q({ side, strike: roundStrike(SPOT * mult, SPOT), daysToExpiry: days })
        const fromApr = quote.capital * (quote.apr / 100) * (days / 365)
        expect(quote.userPremium).toBeCloseTo(fromApr, 10)
      }
    }
  })

  it('never pays above the haircut fair value: user + fee ≤ fair × (1 − baseHaircut)', () => {
    // Sweep strikes including off-ladder and ITM ones.
    for (const side of ['call', 'put'] as const) {
      for (const mult of [0.7, 0.9, 0.98, 1.0, 1.02, 1.06, 1.2, 1.5]) {
        for (const u of [0, 0.5, 0.98]) {
          const quote = q({ side, strike: SPOT * mult, utilization: u })
          const grossUpfront = quote.userPremium + quote.protocolFee
          expect(grossUpfront).toBeLessThanOrEqual(quote.fairPremium * 0.8 + 1e-12)
        }
      }
    }
  })

  it('SECURITY: an off-ladder deep-ITM strike cannot price above the APR ceiling', () => {
    const itm = q({ strike: SPOT * 0.5, daysToExpiry: 21 }) // deep ITM call
    const targetTop = MAX_APR * Math.min(1, 21 / TIME_REF)
    expect(itm.apr).toBeLessThanOrEqual(targetTop * (1 - FEE) + 1e-9)
  })

  it('offered APR never exceeds the time-scaled ceiling (net of fee)', () => {
    for (const days of [2, 7, 14, 21]) {
      const targetTop = MAX_APR * Math.min(1, days / TIME_REF)
      for (const mult of [1.02, 1.06, 1.12, 1.2]) {
        const quote = q({ strike: roundStrike(SPOT * mult, SPOT), daysToExpiry: days })
        expect(quote.apr).toBeLessThanOrEqual(targetTop * (1 - FEE) + 1e-9)
      }
    }
  })

  it('nearest rung quotes at the ceiling when raw BS APR is rich (high vol)', () => {
    const near = roundStrike(SPOT * CALL_STRIKE_MULTIPLIERS[0], SPOT)
    const quote = q({ strike: near, daysToExpiry: 21, sigmaRealized: 1.6 })
    const targetTop = MAX_APR * Math.min(1, 21 / TIME_REF)
    expect(quote.apr).toBeCloseTo(targetTop * (1 - FEE), 6)
    expect(quote.aprCapped).toBe(true)
  })

  it('utilization tapers the PAID premium, not just the display', () => {
    const empty = q({ utilization: 0 })
    const full = q({ utilization: 1 })
    expect(full.userPremium).toBeCloseTo(empty.userPremium * 0.5, 10)
    expect(full.apr).toBeCloseTo(empty.apr * 0.5, 10)
  })

  it('APR rises with tenor (longer lock → higher offered APR)', () => {
    const short = q({ daysToExpiry: 3 })
    const long = q({ daysToExpiry: 21 })
    expect(long.apr).toBeGreaterThan(short.apr)
  })

  it('strike gradient: farther OTM rungs pay strictly less', () => {
    const aprs = [1.02, 1.06, 1.12, 1.2].map(
      (m) => q({ strike: roundStrike(SPOT * m, SPOT) }).apr
    )
    for (let i = 1; i < aprs.length; i++) {
      expect(aprs[i]).toBeLessThan(aprs[i - 1])
    }
  })

  it('capital at risk: spot for calls, strike for puts', () => {
    const call = q({ side: 'call' })
    expect(call.capital).toBe(SPOT)
    const putStrike = roundStrike(SPOT * 0.94, SPOT)
    const put = q({ side: 'put', strike: putStrike })
    expect(put.capital).toBe(putStrike)
  })

  it('protocol fee is exactly the fee share of the gross upfront', () => {
    const quote = q()
    const gross = quote.userPremium + quote.protocolFee
    expect(quote.protocolFee).toBeCloseTo(gross * FEE, 10)
  })

  it('accounting identity: protocolEdge = fair − gross upfront', () => {
    const quote = q()
    const gross = quote.userPremium + quote.protocolFee
    expect(quote.protocolEdge).toBeCloseTo(quote.fairPremium - gross, 10)
  })

  it('forward defaults to spot when omitted or invalid', () => {
    const quote = q({ forward: undefined })
    expect(quote.forward).toBe(SPOT)
    const quote2 = q({ forward: NaN })
    expect(quote2.forward).toBe(SPOT)
  })
})

describe('quoteOption — Greeks', () => {
  // The M3 criterion is that risk shown anywhere matches THIS engine's output.
  // That only holds if the Greeks are evaluated at the σ the strike was priced
  // at — the smile-adjusted one — and not at the at-the-money level.
  it('are evaluated at sigmaStrike, not sigmaOffered', () => {
    for (const mult of CALL_STRIKE_MULTIPLIERS) {
      const strike = roundStrike(SPOT * mult, SPOT)
      const quote = q({ strike })
      const T = quote.daysToExpiry / 365
      expect(quote.delta).toBeCloseTo(
        black76Delta('call', quote.forward, strike, T, quote.sigmaStrike), 12,
      )
      expect(quote.vega).toBeCloseTo(
        black76Vega(quote.forward, strike, T, quote.sigmaStrike), 12,
      )
    }
    // The two σ's differ on the wings, so the wrong one is a detectable error.
    const far = q({ strike: roundStrike(SPOT * 1.2, SPOT) })
    expect(far.sigmaStrike).not.toBeCloseTo(far.sigmaOffered, 3)
    expect(far.delta).not.toBeCloseTo(
      black76Delta('call', far.forward, far.strike, far.daysToExpiry / 365, far.sigmaOffered), 4,
    )
  })

  it('carries the option holder\'s sign, leaving the writer flip to callers', () => {
    for (const mult of CALL_STRIKE_MULTIPLIERS) {
      const call = q({ strike: roundStrike(SPOT * mult, SPOT) })
      expect(call.delta).toBeGreaterThan(0)
      expect(call.vega).toBeGreaterThan(0)
    }
    for (const mult of PUT_STRIKE_MULTIPLIERS) {
      const put = q({ side: 'put', strike: roundStrike(SPOT * mult, SPOT) })
      expect(put.delta).toBeLessThan(0)
      expect(put.vega).toBeGreaterThan(0)
    }
  })

  it('tracks fair value rather than the paid premium', () => {
    // Utilization halves what the user is paid without touching the option's
    // sensitivities — the clearest case of the two being different numbers.
    const empty = q()
    const full = q({ utilization: 1 })
    expect(full.userPremium).toBeLessThan(empty.userPremium)
    expect(full.delta).toBeCloseTo(empty.delta, 12)
    expect(full.vega).toBeCloseTo(empty.vega, 12)
  })

  it('falls away across the ladder as strikes go further out', () => {
    const deltas = CALL_STRIKE_MULTIPLIERS.map(
      (m) => q({ strike: roundStrike(SPOT * m, SPOT) }).delta,
    )
    for (let i = 1; i < deltas.length; i++) {
      expect(deltas[i]).toBeLessThan(deltas[i - 1])
    }
  })
})
