import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Keypair, StrKey } from '@stellar/stellar-sdk'

// The dead-man's switch.
// ======================
// A ping is the one signal that survives the thing it reports on going down,
// so it has to mean the job did its work: the monitor pings when every alert
// it raised was delivered, the sweep for a run that could settle. Neither a
// missing URL nor a failing ping may fail the run.

const fetchMock = vi.fn()
const alerts: any[] = []
let deliver = true

vi.mock('@/lib/monitor/checks', () => ({ runMonitorChecks: async () => alerts }))
vi.mock('@/lib/monitor/notify', () => ({ sendAlert: async () => ({ delivered: deliver }) }))
vi.mock('@/lib/monitor/triggers', () => ({ applyAutoBreaker: async () => [] }))
vi.mock('@/lib/db-queries', () => ({ purgeOldIps: async () => null }))
vi.mock('@/lib/retention', () => ({ purgeOldAnalyticsEvents: async () => null }))
vi.mock('@/lib/quote-policy', () => ({ sweepLapsedReservations: async () => null }))
vi.mock('@/lib/monitor/runner-watch', () => ({
  recordRunStart: async () => null,
  recordRunEnd: async () => {},
}))

const getVaultStats = vi.fn()
vi.mock('@/lib/vault-contract', () => ({
  getVaultStats: (...a: any[]) => getVaultStats(...a),
  getPosition: async () => null,
  getPositionsOf: async () => [],
  settlePosition: async () => ({}),
  recordExpiryPrice: async () => null,
}))

const { pingHeartbeat } = await import('../monitor/heartbeat')
let monitor: typeof import('@/app/api/cron/monitor/route')
let sweep: typeof import('../settlement-sweep')

beforeAll(async () => {
  process.env.CRON_SECRET = 'test-cron-secret'
  process.env.NEXT_PUBLIC_VAULT_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 0x11))
  monitor = await import('@/app/api/cron/monitor/route')
  sweep = await import('../settlement-sweep')
})

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 })
  vi.stubGlobal('fetch', fetchMock)
  process.env.MONITOR_HEARTBEAT_URL = 'https://hc.example/monitor'
  process.env.SETTLE_HEARTBEAT_URL = 'https://hc.example/settle'
  alerts.length = 0
  deliver = true
  getVaultStats.mockReset().mockResolvedValue({
    escrowedCall: 0, escrowedPut: 0, owedCall: 0, owedPut: 0, cashBalance: 0, underlyingBalance: 0, nextId: 0,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.MONITOR_HEARTBEAT_URL
  delete process.env.SETTLE_HEARTBEAT_URL
})

const pinged = (url: string) => fetchMock.mock.calls.some(([u]) => u === url)

describe('pingHeartbeat', () => {
  it('is skipped, not an error, when no URL is configured', async () => {
    delete process.env.MONITOR_HEARTBEAT_URL
    expect(await pingHeartbeat('monitor')).toEqual({ status: 'skipped', reason: 'MONITOR_HEARTBEAT_URL not set' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a refused or failed ping without throwing', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 })
    expect(await pingHeartbeat('settle')).toEqual({ status: 'error', reason: 'HTTP 404' })
    fetchMock.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'))
    expect((await pingHeartbeat('settle')).status).toBe('error')
  })
})

const runMonitor = () =>
  monitor.GET(new Request('http://t/api/cron/monitor', { headers: { authorization: 'Bearer test-cron-secret' } }))

describe('the monitor run', () => {
  it('pings when it ran and every alert it raised went out', async () => {
    alerts.push({ severity: 'warning', title: 't', message: 'm' })
    const out = await (await runMonitor()).json()
    expect(out.heartbeat).toBe('sent')
    expect(pinged('https://hc.example/monitor')).toBe(true)
  })

  it('does not ping when an alert reached no channel, so a dead channel is caught too', async () => {
    alerts.push({ severity: 'critical', title: 't', message: 'm' })
    deliver = false
    const out = await (await runMonitor()).json()
    expect(out.heartbeat).toBe('skipped')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the settlement run', () => {
  it('pings for a run that could settle', async () => {
    await sweep.sweepOnce({ runnerSecret: Keypair.random().secret() })
    expect(pinged('https://hc.example/settle')).toBe(true)
  })

  it('does not ping for a run with no key, which can only scan', async () => {
    await sweep.sweepOnce({ runnerSecret: '' })
    expect(pinged('https://hc.example/settle')).toBe(false)
  })

  it('does not ping for a dry run', async () => {
    await sweep.sweepOnce({ dryRun: true })
    expect(pinged('https://hc.example/settle')).toBe(false)
  })
})
