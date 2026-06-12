import { describe, it, expect } from 'vitest'
import {
  upcomingExpiryDates,
  maxOpenExpiryDays,
  expiryUtilization,
  expiryLabel,
  dynamicAprFactor,
  MIN_DAYS_TO_EXPIRY,
  ACTIVE_EXPIRY_COUNT,
  REAL_DISTRIBUTION,
} from '../expiries'

describe('upcomingExpiryDates', () => {
  it('returns ACTIVE_EXPIRY_COUNT consecutive Fridays at 08:00 UTC', () => {
    const from = new Date('2026-06-08T12:00:00Z') // Monday
    const dates = upcomingExpiryDates(from)
    expect(dates).toHaveLength(ACTIVE_EXPIRY_COUNT)
    for (const d of dates) {
      expect(d.getUTCDay()).toBe(5)
      expect(d.getUTCHours()).toBe(8)
      expect(d.getUTCMinutes()).toBe(0)
    }
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i].getTime() - dates[i - 1].getTime()).toBe(7 * 86400_000)
    }
  })

  it('respects the MIN_DAYS_TO_EXPIRY cutoff (no same-week rush)', () => {
    // Thursday afternoon: this week's Friday is < 2 days away → skip to next.
    const from = new Date('2026-06-11T12:00:00Z') // Thursday
    const [first] = upcomingExpiryDates(from)
    expect(first.toISOString()).toBe('2026-06-19T08:00:00.000Z')
    const daysAway = (first.getTime() - from.getTime()) / 86400_000
    expect(daysAway).toBeGreaterThanOrEqual(MIN_DAYS_TO_EXPIRY)
  })

  it('keeps this week\'s Friday while it is still far enough out', () => {
    const from = new Date('2026-06-08T12:00:00Z') // Monday → Friday is 3.8d away
    const [first] = upcomingExpiryDates(from)
    expect(first.toISOString()).toBe('2026-06-12T08:00:00.000Z')
  })
})

describe('maxOpenExpiryDays', () => {
  it('is the farthest open expiry, at least MIN_DAYS', () => {
    const from = new Date('2026-06-08T12:00:00Z')
    const days = maxOpenExpiryDays(from)
    const dates = upcomingExpiryDates(from)
    const last = dates[dates.length - 1]
    expect(days).toBe(Math.ceil((last.getTime() - from.getTime()) / 86400_000))
    expect(days).toBeGreaterThanOrEqual(MIN_DAYS_TO_EXPIRY)
  })
})

describe('expiryUtilization', () => {
  it('front expiry carries full utilization, later ones taper', () => {
    expect(expiryUtilization(0.5, 0)).toBeCloseTo(0.5 * REAL_DISTRIBUTION[0], 10)
    expect(expiryUtilization(0.5, 1)).toBeCloseTo(0.5 * REAL_DISTRIBUTION[1], 10)
    expect(expiryUtilization(0.5, 2)).toBeCloseTo(0.5 * REAL_DISTRIBUTION[2], 10)
  })

  it('clamps to [0, 0.98] and survives out-of-range slots', () => {
    expect(expiryUtilization(5, 0)).toBe(0.98)
    expect(expiryUtilization(-1, 0)).toBe(0)
    expect(expiryUtilization(0.5, 99)).toBeCloseTo(
      0.5 * REAL_DISTRIBUTION[REAL_DISTRIBUTION.length - 1],
      10
    )
  })
})

describe('expiryLabel', () => {
  it('formats as Mon_DD in UTC', () => {
    expect(expiryLabel(new Date('2026-06-12T08:00:00Z'))).toBe('Jun_12')
    expect(expiryLabel(new Date('2026-01-02T08:00:00Z'))).toBe('Jan_02')
  })
})

describe('dynamicAprFactor (legacy preview factor)', () => {
  it('never boosts above fair value (≤ 1) and never goes negative', () => {
    for (const days of [1, 7, 14, 30]) {
      for (const u of [0, 0.5, 0.8, 1]) {
        const f = dynamicAprFactor(days, u)
        expect(f).toBeGreaterThanOrEqual(0)
        expect(f).toBeLessThanOrEqual(1)
      }
    }
  })

  it('drops hard above the utilization kink', () => {
    const atKink = dynamicAprFactor(14, 0.8)
    const nearFull = dynamicAprFactor(14, 0.99)
    expect(nearFull).toBeLessThan(atKink * 0.5)
  })
})
