import { describe, it, expect, vi } from 'vitest'

// Feedback and security reports keep the client address for abuse triage, and
// only for so long. The rows stay; the address goes.

const calls: { sql: string; params: any[] }[] = []
vi.mock('../db', () => ({
  ensureSchema: async () => {},
  getPool: () => ({
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params })
      return { rows: [], rowCount: sql.includes('feedback') ? 3 : 1 }
    },
  }),
}))

import { purgeOldIps, IP_RETENTION_DAYS } from '../db-queries'

describe('purgeOldIps', () => {
  it('clears the address on old rows in both tables and deletes nothing', async () => {
    const out = await purgeOldIps()
    expect(out).toEqual({ feedback: 3, securityReports: 1 })
    expect(calls.map((c) => c.sql).join(' ')).not.toMatch(/delete/i)
    expect(calls.every((c) => /set ip = null/.test(c.sql))).toBe(true)
    expect(calls[0].params).toEqual([`${IP_RETENTION_DAYS} days`])
  })
})
