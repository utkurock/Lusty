import { beforeEach, describe, expect, it, vi } from 'vitest'

// /api/health reports the release.
// ================================
// Which network, which wasm each book runs and whether it is the reviewed one,
// and whether the network still matches its manifest. Drift and a missing
// manifest turn the probe red; a network that could not be read does not.
// Which difference it was is for operators only.

let state: any
let admin = false
const reads = vi.fn()

vi.mock('@/lib/monitor/release-drift', () => ({
  readReleaseState: async () => {
    reads()
    return state
  },
}))
vi.mock('@/lib/admin-auth', () => ({ isAdminRequest: async () => admin }))
vi.mock('@/lib/lusd', () => ({ LUSD_DISTRIBUTOR: 'GDISTRIBUTOR' }))
vi.mock('@stellar/stellar-sdk', async (orig) => {
  const real = await orig<typeof import('@stellar/stellar-sdk')>()
  class Server {
    async loadAccount() {
      return {}
    }
  }
  return { ...real, Horizon: { ...real.Horizon, Server } }
})
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: async () => ({ rows: [] }) }) }))
vi.mock('@/lib/spot', () => ({ getSpot: async () => ({ price: 1, source: 'reflector' }), resetSpotCache: () => {} }))
vi.mock('@/lib/assets', () => ({ allUnderlyings: () => [], enabledUnderlyings: () => [] }))
vi.mock('@/lib/vault-limits', () => ({ reconcileAll: async () => [], readPause: async () => ({ paused: false }) }))
vi.mock('@/lib/routing/budget', () => ({ routingExposure: () => [] }))

const HASH = 'b6'.repeat(32)
const books = [
  { symbol: 'XLM', vault: 'CXLM', wasmHash: HASH },
  { symbol: 'BTC', vault: 'CBTC', wasmHash: HASH },
]
const good = () => ({ status: 'ok', network: 'testnet', reviewedWasmHash: HASH, books, drift: [], manifest: {} })

async function probe() {
  vi.resetModules()
  const route = await import('@/app/api/health/route')
  const res = await route.GET(new Request('http://t/api/health'))
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  state = good()
  admin = false
  reads.mockClear()
})

describe('the release in /api/health', () => {
  it('names the network and the reviewed wasm each book runs, and is green', async () => {
    const { status, body } = await probe()
    expect(status).toBe(200)
    expect(body.network).toBe('testnet')
    expect(body.components.release).toMatchObject({ ok: true, status: 'ok', reviewedWasmHash: HASH, differences: 0 })
    expect(body.components.release.books).toEqual([
      { underlying: 'XLM', vault: 'CXLM', wasmHash: HASH, reviewed: true },
      { underlying: 'BTC', vault: 'CBTC', wasmHash: HASH, reviewed: true },
    ])
  })

  it('turns red on drift, and says how much without saying what to the public', async () => {
    state = {
      ...good(),
      status: 'drift',
      books: [books[0], { ...books[1], wasmHash: 'ab'.repeat(32) }],
      drift: [{ path: 'wasmHash', expected: HASH, observed: 'x' }],
    }
    const { status, body } = await probe()
    expect(status).toBe(503)
    expect(body.components.release).toMatchObject({ ok: false, status: 'drift', differences: 1 })
    expect(body.components.release.books[1].reviewed).toBe(false)
    expect(body.components.release.drift).toBeUndefined()
  })

  it('gives an operator each difference', async () => {
    admin = true
    state = { ...good(), status: 'drift', drift: [{ path: 'accounts.GA.thresholds.high', expected: 2, observed: 1 }] }
    const { body } = await probe()
    expect(body.components.release.drift).toEqual(['accounts.GA.thresholds.high: manifest 2, network 1'])
  })

  it('turns red without a manifest, and hides the error text from the public', async () => {
    state = { status: 'no-manifest', network: 'public', error: 'ENOENT: /srv/app/release/public.json' }
    const { status, body } = await probe()
    expect(status).toBe(503)
    expect(body.components.release).toMatchObject({ ok: false, status: 'no-manifest', error: 'unavailable' })
  })

  it('reports a network it could not read without scoring it', async () => {
    state = { status: 'unreadable', network: 'testnet', error: 'RPC 503' }
    const { status, body } = await probe()
    expect(status).toBe(200)
    expect(body.components.release).toMatchObject({ ok: true, status: 'unreadable' })
  })

  it('reads the release once per five minutes, not once per probe', async () => {
    vi.resetModules()
    const route = await import('@/app/api/health/route')
    vi.useFakeTimers({ now: Date.parse('2026-11-27T12:00:00Z') })
    try {
      await route.GET(new Request('http://t/api/health'))
      vi.setSystemTime(Date.parse('2026-11-27T12:01:00Z'))
      await route.GET(new Request('http://t/api/health'))
      expect(reads).toHaveBeenCalledTimes(1)
      vi.setSystemTime(Date.parse('2026-11-27T12:06:00Z'))
      await route.GET(new Request('http://t/api/health'))
      expect(reads).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
