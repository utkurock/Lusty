import { describe, it, expect } from 'vitest'
import {
  normalCDF,
  black76Call,
  black76Put,
  niceStrikeStep,
  roundStrike,
  calculateAPR,
  CALL_STRIKE_MULTIPLIERS,
  PUT_STRIKE_MULTIPLIERS,
  callStrikeLabel,
  putStrikeLabel,
} from '../pricing'

describe('normalCDF (Abramowitz-Stegun)', () => {
  it('is 0.5 at zero', () => {
    expect(normalCDF(0)).toBeCloseTo(0.5, 7)
  })

  it('matches known quantiles', () => {
    // Φ(1.96) ≈ 0.9750, Φ(1) ≈ 0.8413, Φ(2.5758) ≈ 0.9950
    expect(normalCDF(1.96)).toBeCloseTo(0.975, 3)
    expect(normalCDF(1)).toBeCloseTo(0.8413, 3)
    expect(normalCDF(2.5758)).toBeCloseTo(0.995, 3)
  })

  it('is symmetric: Φ(-x) = 1 - Φ(x)', () => {
    for (const x of [0.3, 1, 2.2, 4]) {
      expect(normalCDF(-x)).toBeCloseTo(1 - normalCDF(x), 6)
    }
  })

  it('saturates in the tails', () => {
    expect(normalCDF(8)).toBeCloseTo(1, 6)
    expect(normalCDF(-8)).toBeCloseTo(0, 6)
  })
})

describe('Black-76', () => {
  const F = 0.23
  const T = 7 / 365
  const VOL = 0.9

  it('satisfies put-call parity: C - P = F - K (r=0)', () => {
    for (const K of [0.18, 0.22, 0.23, 0.25, 0.3]) {
      const c = black76Call(F, K, T, VOL)
      const p = black76Put(F, K, T, VOL)
      expect(c - p).toBeCloseTo(F - K, 8)
    }
  })

  it('returns intrinsic value at expiry (T=0)', () => {
    expect(black76Call(0.25, 0.23, 0, VOL)).toBeCloseTo(0.02, 10)
    expect(black76Call(0.21, 0.23, 0, VOL)).toBe(0)
    expect(black76Put(0.21, 0.23, 0, VOL)).toBeCloseTo(0.02, 10)
    expect(black76Put(0.25, 0.23, 0, VOL)).toBe(0)
  })

  it('returns intrinsic value at zero vol', () => {
    expect(black76Call(0.25, 0.23, T, 0)).toBeCloseTo(0.02, 10)
    expect(black76Put(0.25, 0.23, T, 0)).toBe(0)
  })

  it('premium increases with vol (vega > 0)', () => {
    const lo = black76Call(F, 0.25, T, 0.5)
    const hi = black76Call(F, 0.25, T, 1.5)
    expect(hi).toBeGreaterThan(lo)
  })

  it('premium increases with time', () => {
    const week = black76Put(F, 0.21, 7 / 365, VOL)
    const month = black76Put(F, 0.21, 30 / 365, VOL)
    expect(month).toBeGreaterThan(week)
  })

  it('call premium never exceeds the forward, put never exceeds strike', () => {
    for (const K of [0.1, 0.23, 0.5]) {
      expect(black76Call(F, K, 1, 3)).toBeLessThanOrEqual(F)
      expect(black76Put(F, K, 1, 3)).toBeLessThanOrEqual(K)
    }
  })

  it('OTM premium is below ITM premium for same distance', () => {
    const otmCall = black76Call(F, F * 1.1, T, VOL)
    const itmCall = black76Call(F, F * 0.9, T, VOL)
    expect(itmCall).toBeGreaterThan(otmCall)
  })
})

describe('strike rounding (1-2-5 ladder)', () => {
  it('picks a tick near 1% of spot from the 1-2-5 family', () => {
    // spot 0.23 → target 0.0023 → 0.002
    expect(niceStrikeStep(0.23)).toBeCloseTo(0.002, 10)
    // spot 100 → target 1 → 1
    expect(niceStrikeStep(100)).toBe(1)
    // spot 420 → target 4.2 → 5
    expect(niceStrikeStep(420)).toBe(5)
    // spot 1500 → target 15 → 20
    expect(niceStrikeStep(1500)).toBe(20)
  })

  it('guards non-positive spot', () => {
    expect(niceStrikeStep(0)).toBe(1)
    expect(niceStrikeStep(-5)).toBe(1)
  })

  it('rounds strikes onto the tick grid', () => {
    const spot = 0.23
    const step = niceStrikeStep(spot)
    const k = roundStrike(spot * 1.06, spot)
    expect(k / step).toBeCloseTo(Math.round(k / step), 8)
  })
})

describe('calculateAPR', () => {
  it('annualizes the premium yield', () => {
    // 1% premium over ~36.5 days → 10% APR
    expect(calculateAPR(1, 100, 36.5)).toBeCloseTo(10, 6)
  })

  it('guards division by zero', () => {
    expect(calculateAPR(1, 0, 7)).toBe(0)
    expect(calculateAPR(1, 100, 0)).toBe(0)
  })
})

describe('strike ladders', () => {
  it('call rungs go up, put rungs go down, nearest first', () => {
    expect(CALL_STRIKE_MULTIPLIERS[0]).toBeGreaterThan(1)
    expect([...CALL_STRIKE_MULTIPLIERS]).toEqual(
      [...CALL_STRIKE_MULTIPLIERS].sort((a, b) => a - b)
    )
    expect(PUT_STRIKE_MULTIPLIERS[0]).toBeLessThan(1)
    expect([...PUT_STRIKE_MULTIPLIERS]).toEqual(
      [...PUT_STRIKE_MULTIPLIERS].sort((a, b) => b - a)
    )
  })

  it('labels render the OTM distance', () => {
    expect(callStrikeLabel(1.06)).toBe('+6% OTM')
    expect(putStrikeLabel(0.94)).toBe('-6% OTM')
  })
})
