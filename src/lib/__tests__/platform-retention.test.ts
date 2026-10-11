import { describe, it, expect, vi, beforeEach } from 'vitest'

// Every accepted analytics event was a permanent row. The limits bound how fast
// the table grows, not how large it gets; retention bounds that.

const calls = vi.hoisted(() => [] as { sql: string; params: any[] }[])
const counts = vi.hoisted(() => ({ value: [] as number[] }))

vi.mock('../db', () => ({
  ensureSchema: async () => {},
  getPool: () => ({
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params })
      return { rows: [], rowCount: counts.value.shift() ?? 0 }
    },
  }),
}))

import {
  analyticsRetentionDays,
  DEFAULT_ANALYTICS_RETENTION_DAYS,
  purgeOldAnalyticsEvents,
} from '../retention'

beforeEach(() => {
  calls.length = 0
  counts.value = []
})

describe('purgeOldAnalyticsEvents', () => {
  it('deletes only analytics rows past the window, a batch at a time', async () => {
    counts.value = [5000, 1200]
    const out = await purgeOldAnalyticsEvents(30)

    expect(out).toEqual({ deleted: 6200, more: false })
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      expect(c.sql).toMatch(/delete from analytics_events/)
      expect(c.sql).toMatch(/created_at < now\(\) - \$1::interval/)
      expect(c.params).toEqual(['30 days', 5000])
    }
  })

  it('stops after a bounded number of batches and says a backlog is left', async () => {
    counts.value = Array(50).fill(5000)
    const out = await purgeOldAnalyticsEvents(30)
    expect(out.more).toBe(true)
    expect(calls.length).toBe(20)
  })

  it('never deletes with a window under a day', async () => {
    await purgeOldAnalyticsEvents(0)
    expect(calls[0].params[0]).toBe('1 days')
  })
})

describe('analyticsRetentionDays', () => {
  it('reads the environment and falls back to the default on nonsense', () => {
    expect(analyticsRetentionDays('30')).toBe(30)
    expect(analyticsRetentionDays(undefined)).toBe(DEFAULT_ANALYTICS_RETENTION_DAYS)
    expect(analyticsRetentionDays('0')).toBe(DEFAULT_ANALYTICS_RETENTION_DAYS)
    expect(analyticsRetentionDays('-5')).toBe(DEFAULT_ANALYTICS_RETENTION_DAYS)
    expect(analyticsRetentionDays('ninety')).toBe(DEFAULT_ANALYTICS_RETENTION_DAYS)
  })
})
