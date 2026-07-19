import { describe, it, expect } from 'vitest'
import { pickSpot } from '../spot'

// Defaults assumed by these tests (env unset in the test runner):
//   SPOT_MAX_STALENESS_SECS=900   (15 min)
//   future-skew tolerance         = 300s
const NOW = 1_784_500_000_000 // fixed unix ms; NOW/1000 = 1784500000
const NOW_SECS = Math.floor(NOW / 1000)

const rec = (price: number, ageSecs: number) => ({
  price,
  timestamp: NOW_SECS - ageSecs,
})

describe('pickSpot — source precedence', () => {
  it('prefers reflector when it is fresh, even if binance also answered', () => {
    const got = pickSpot(rec(0.188, 120), 0.191, NOW)
    expect(got).toEqual({
      price: 0.188,
      source: 'reflector',
      asOf: (NOW_SECS - 120) * 1000,
    })
  })

  it('falls back to binance when reflector returned nothing', () => {
    const got = pickSpot(null, 0.191, NOW)
    expect(got?.source).toBe('binance')
    expect(got?.price).toBe(0.191)
    expect(got?.asOf).toBe(NOW)
  })

  it('returns null when every source is down — never invents a price', () => {
    expect(pickSpot(null, null, NOW)).toBeNull()
  })
})

describe('pickSpot — reflector staleness bound', () => {
  it('accepts a record exactly at the bound', () => {
    expect(pickSpot(rec(0.188, 900), 0.191, NOW)?.source).toBe('reflector')
  })

  it('rejects a record past the bound and uses binance instead', () => {
    const got = pickSpot(rec(0.188, 901), 0.191, NOW)
    expect(got?.source).toBe('binance')
    expect(got?.price).toBe(0.191)
  })

  it('a stale reflector with no binance is a failure, not a stale quote', () => {
    // The whole point of the bound: a stalled oracle must not keep quoting
    // against a market that has moved on.
    expect(pickSpot(rec(0.188, 5000), null, NOW)).toBeNull()
  })

  it('tolerates small clock skew but rejects a far-future record', () => {
    expect(pickSpot(rec(0.188, -300), 0.191, NOW)?.source).toBe('reflector')
    expect(pickSpot(rec(0.188, -301), 0.191, NOW)?.source).toBe('binance')
  })
})

describe('pickSpot — malformed inputs', () => {
  it('skips a non-positive or non-finite reflector price', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(pickSpot(rec(bad, 60), 0.191, NOW)?.source).toBe('binance')
    }
  })

  it('skips a non-positive or non-finite binance price', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(pickSpot(null, bad, NOW)).toBeNull()
    }
  })

  it('does not let a bad binance price mask a good reflector one', () => {
    expect(pickSpot(rec(0.188, 60), NaN, NOW)?.price).toBe(0.188)
  })
})
