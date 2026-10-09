import { describe, it, expect, vi } from 'vitest'

// A public route that fails answers with a reference, not with the driver's
// own text — which names the database host and role.

vi.mock('@/lib/db-queries', () => ({
  getLeaderboard: async () => {
    throw new Error('password authentication failed for user "postgres.abcdefgh" at db.internal:6543')
  },
  getUserStats: async () => null,
}))

describe('errors a public route hands back', () => {
  it('carry a reference the server log can be searched for, and no driver text', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { GET } = await import('@/app/api/leaderboard/route')
    const res = await GET(new Request('http://t/api/leaderboard', { headers: { 'cf-connecting-ip': '192.0.2.50' } }))
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(JSON.stringify(body)).not.toMatch(/postgres|password|6543/)
    expect(body.ref).toMatch(/^ref [0-9a-f]{8}$/)
    expect(String(log.mock.calls[0][0])).toContain(body.ref)
    log.mockRestore()
  })
})
