import { describe, it, expect } from 'vitest'
import { currentEpochStart } from '../monitor/triggers'

// The weekly loss-cap epoch starts the most recent Friday 08:00 UTC.
describe('currentEpochStart', () => {
  it('mid-week → previous Friday 08:00 UTC', () => {
    const start = currentEpochStart(new Date('2026-06-10T15:00:00Z')) // Wednesday
    expect(start.toISOString()).toBe('2026-06-05T08:00:00.000Z')
  })

  it('Friday after 08:00 → same day', () => {
    const start = currentEpochStart(new Date('2026-06-12T09:00:00Z'))
    expect(start.toISOString()).toBe('2026-06-12T08:00:00.000Z')
  })

  it('Friday before 08:00 → previous Friday (epoch not rolled yet)', () => {
    const start = currentEpochStart(new Date('2026-06-12T07:59:00Z'))
    expect(start.toISOString()).toBe('2026-06-05T08:00:00.000Z')
  })

  it('always lands on a Friday 08:00 UTC in the past', () => {
    for (let i = 0; i < 14; i++) {
      const now = new Date(Date.UTC(2026, 5, 1 + i, 13, 30))
      const start = currentEpochStart(now)
      expect(start.getUTCDay()).toBe(5)
      expect(start.getUTCHours()).toBe(8)
      expect(start.getTime()).toBeLessThanOrEqual(now.getTime())
      // Never more than a week back.
      expect(now.getTime() - start.getTime()).toBeLessThan(8 * 86400_000)
    }
  })
})
