import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

// The monitor's timer is what settles lapsed quote reservations for wallets
// that never come back. It must run every sweep, read each owner's positions
// from that owner's own book, keep counting what it cannot read, and never
// stop the risk checks when it fails.

const sweep = vi.fn()
const getPositionsOf = vi.fn(async (..._a: any[]) => [])

vi.mock('@/lib/monitor/checks', () => ({ runMonitorChecks: async () => [] }))
vi.mock('@/lib/monitor/notify', () => ({ sendAlert: async () => ({ delivered: true }) }))
vi.mock('@/lib/monitor/triggers', () => ({
  applyAutoBreaker: async () => ({
    changed: false,
    state: { tripped: false, source: 'auto' },
    evaluation: { reasons: [] },
  }),
}))
vi.mock('@/lib/db-queries', () => ({ purgeOldIps: async () => ({ feedback: 0, securityReports: 0 }) }))
vi.mock('@/lib/quote-policy', () => ({
  sweepLapsedReservations: (...a: any[]) => sweep(...a),
}))
vi.mock('@/lib/vault-contract', () => ({
  getPositionsOf: (...a: any[]) => getPositionsOf(...a),
}))

let monitor: typeof import('@/app/api/cron/monitor/route')

beforeAll(async () => {
  process.env.CRON_SECRET = 'test-cron-secret'
  monitor = await import('@/app/api/cron/monitor/route')
})

beforeEach(() => {
  sweep.mockReset()
  getPositionsOf.mockClear()
})

const run = () =>
  monitor.GET(
    new Request('http://t/api/cron/monitor', {
      headers: { authorization: 'Bearer test-cron-secret' },
    }),
  )

describe('the monitor sweeps lapsed reservations', () => {
  it('runs the sweep and reports what it settled', async () => {
    sweep.mockResolvedValue({ owners: 2, opened: 0, unused: 3, kept: 0 })
    const res = await run()
    const out = await res.json()

    expect(sweep).toHaveBeenCalledTimes(1)
    expect(out.reservationsSwept).toEqual({ owners: 2, opened: 0, unused: 3, kept: 0 })
  })

  it('reads each owner from the book its reservation names, and refuses an unknown one', async () => {
    sweep.mockImplementation(async (read: (a: string, u: string) => Promise<unknown>) => {
      await read('GOWNER', 'XLM')
      await expect(read('GOWNER', 'NOPE')).rejects.toThrow()
      return { owners: 1, opened: 0, unused: 0, kept: 0 }
    })
    await run()

    expect(getPositionsOf).toHaveBeenCalledTimes(1)
    expect(getPositionsOf).toHaveBeenCalledWith('GOWNER', 100, expect.objectContaining({ symbol: 'XLM' }))
  })

  it('still answers the risk sweep when the reservation sweep fails', async () => {
    sweep.mockRejectedValue(new Error('connect ECONNREFUSED'))
    const res = await run()
    expect(res.status).toBe(200)
    expect((await res.json()).reservationsSwept).toBeUndefined()
  })
})
