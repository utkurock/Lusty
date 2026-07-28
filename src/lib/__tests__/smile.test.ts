import { describe, it, expect } from 'vitest'
import { smileFactor, standardisedMoneyness, smileVol } from '../smile'

describe('smileFactor ψ(z)', () => {
  it('leaves at-the-money vol essentially alone', () => {
    expect(smileFactor(0)).toBeCloseTo(1.009, 3)
  })

  it('dips below the at-the-money level just above the forward', () => {
    // Derive's fitted m is positive at every expiry: the cheapest vol on the
    // board is a slightly out-of-the-money call, not the forward itself.
    expect(smileFactor(0.5)).toBeLessThan(1)
    expect(smileFactor(0.5)).toBeLessThan(smileFactor(0))
    expect(smileFactor(0.5)).toBeLessThan(smileFactor(1.5))
  })

  it('lifts both wings, the downside harder', () => {
    expect(smileFactor(-2)).toBeGreaterThan(smileFactor(2))
    expect(smileFactor(2)).toBeGreaterThan(1)
    expect(smileFactor(-2)).toBeGreaterThan(1.3)
  })

  it('is monotone away from the vertex', () => {
    for (let z = -4; z < 0.5; z += 0.25) {
      expect(smileFactor(z)).toBeGreaterThanOrEqual(smileFactor(z + 0.25) - 1e-12)
    }
    for (let z = 0.5; z < 4; z += 0.25) {
      expect(smileFactor(z + 0.25)).toBeGreaterThanOrEqual(smileFactor(z) - 1e-12)
    }
  })

  it('flattens outside the fitted range rather than extrapolating', () => {
    // Derive clamps its own curve past four standard deviations; an
    // extrapolated wing is a number nobody has traded.
    expect(smileFactor(-50)).toBe(smileFactor(-2))
    expect(smileFactor(50)).toBe(smileFactor(2))
  })

  it('survives degenerate input', () => {
    expect(smileFactor(NaN)).toBe(1)
    expect(smileFactor(Infinity)).toBe(smileFactor(2))
  })
})

describe('standardisedMoneyness', () => {
  it('measures distance in expected-move units, not percent', () => {
    // The whole point of z: the same 10% out of the money is far out for a
    // low-vol asset and barely out for a high-vol one.
    const T = 10 / 365
    const btcLike = standardisedMoneyness(100, 110, T, 0.345)
    const xlmLike = standardisedMoneyness(100, 110, T, 0.9)
    expect(btcLike).toBeGreaterThan(1.5)
    expect(xlmLike).toBeLessThan(0.8)
  })

  it('is zero at the forward and signed by direction', () => {
    const T = 10 / 365
    expect(standardisedMoneyness(100, 100, T, 0.9)).toBeCloseTo(0, 12)
    expect(standardisedMoneyness(100, 80, T, 0.9)).toBeLessThan(0)
    expect(standardisedMoneyness(100, 120, T, 0.9)).toBeGreaterThan(0)
  })

  it('returns 0 rather than NaN on nonsense inputs', () => {
    expect(standardisedMoneyness(100, 110, 0, 0.9)).toBe(0)
    expect(standardisedMoneyness(0, 110, 0.1, 0.9)).toBe(0)
    expect(standardisedMoneyness(100, 0, 0.1, 0.9)).toBe(0)
  })
})

describe('smileVol', () => {
  it('anchors on the at-the-money level', () => {
    const T = 10 / 365
    expect(smileVol(100, 100, T, 0.9)).toBeCloseTo(0.9 * smileFactor(0), 10)
  })

  it('moves XLM strikes only slightly, and BTC strikes a lot', () => {
    // At XLM's vol the whole ladder sits inside one standard deviation, where
    // the smile is flat; at BTC's it does not. This is why the shape had to be
    // borrowed in z rather than in percent-out-of-the-money.
    const T = 10 / 365
    const xlm = smileVol(100, 120, T, 0.9) / 0.9
    const btc = smileVol(100, 120, T, 0.345) / 0.345
    expect(xlm).toBeLessThan(1.1)
    expect(btc).toBeGreaterThan(1.1)
  })
})
