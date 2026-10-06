import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { Keypair, StrKey } from '@stellar/stellar-sdk'

// Class 19: every dependency down, one at a time.
// ===============================================
// docs/ADVERSARIAL.md class 19 asks whether an outage gets a quote, a deposit,
// a payout or a settlement through that would have been refused with the
// dependency up. This is the matrix for the co-signature, the one call that
// lets a position open: each test takes exactly one dependency down, leaves
// the rest healthy, and asserts no signature comes back.
//
// The healthy baseline runs every check and stops at the entry decode, because
// the test hands in a placeholder entry. Reaching that point is what shows the
// checks above it passed; any outage below has to stop the request earlier.
//
// Payouts under a Horizon outage are in payout-submit.test.ts, routed swaps in
// routing-session.test.ts, market inputs in feed-cooldown.test.ts and the
// settlement runner in settlement.test.ts.

const XLM_VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x11))
const WRITER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x66))

const down = {
  breaker: false,
  db: false,
  spot: false,
  limitsRpc: false,
  sigma: false,
}

const query = vi.fn(async (_sql: string) => {
  if (down.db) throw new Error('connect ECONNREFUSED')
  return { rows: [], rowCount: 0 }
})
vi.mock('@/lib/db', () => ({
  ensureSchema: async () => {
    if (down.db) throw new Error('connect ECONNREFUSED')
  },
  getPool: () => ({ query: (sql: string) => query(sql) }),
}))
vi.mock('@/lib/circuit-breaker', () => ({
  getBreakerState: async () => {
    if (down.breaker) throw new Error('connect ECONNREFUSED')
    return { tripped: false }
  },
}))
vi.mock('@/lib/spot', () => ({
  getSpot: async (asset: any) => {
    if (down.spot) throw new Error(`price feed unavailable for ${asset.symbol}: reflector and binance both failed`)
    return { price: 0.25, symbol: asset.symbol, source: 'reflector', asOf: Date.now() }
  },
}))
vi.mock('@/lib/vol', () => ({
  getRealizedVol: async (asset: any) => {
    if (down.sigma) throw new Error(`realized-vol: no price history for ${asset.symbol}`)
    return { sigma: 0.8, sigmaSimple: 0.8, method: 'test', samples: 59, windowDays: 60, asOf: Date.now() }
  },
}))
vi.mock('@/lib/forward', () => ({
  getForward: async (spot: number, timeYears: number) => ({
    forward: spot, spot, fundingAnnual: 0, source: 'spot-fallback', timeYears,
  }),
}))
vi.mock('@/lib/vault-contract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../vault-contract')>()),
  getVaultLimits: async (asset: any) => {
    if (down.limitsRpc) throw new Error('soroban rpc: 503 Service Unavailable')
    return asset.onchainLimits
  },
}))
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ ok: true }),
  durableRateLimit: async () => ({ ok: true }),
}))

let authorize: typeof import('@/app/api/vault/authorize/route')
let resetLimitsCache: () => void

beforeAll(async () => {
  process.env.NEXT_PUBLIC_VAULT_CONTRACT = XLM_VAULT
  process.env.VAULT_QUOTER_SECRET = Keypair.random().secret()
  authorize = await import('@/app/api/vault/authorize/route')
  resetLimitsCache = (await import('../vault-limits')).resetLimitsCache
})

beforeEach(() => {
  for (const k of Object.keys(down) as (keyof typeof down)[]) down[k] = false
  resetLimitsCache()
  query.mockClear()
})

const cosign = async () => {
  const res = await authorize.POST(
    new Request('http://t/api/vault/authorize', {
      method: 'POST',
      body: JSON.stringify({
        address: WRITER,
        side: 'call',
        collateralAmount: 100,
        strikePrice: 0.3,
        expiryIso: new Date(Date.now() + 10 * 86_400_000).toISOString(),
        premium: 0,
        authEntries: ['AAAA'],
      }),
    }),
  )
  return { status: res.status, body: await res.json() }
}

describe('the co-signature with one dependency down', () => {
  it('baseline: everything up, every check passes and only the placeholder entry is refused', async () => {
    const { status, body } = await cosign()
    expect(status).toBe(400)
    expect(body.error).toBe('malformed authEntries')
  })

  it('circuit breaker unreadable: refused, not assumed open', async () => {
    down.breaker = true
    const { status, body } = await cosign()
    expect(status).toBe(503)
    expect(body.code).toBe('breaker_unavailable')
    expect(body.authEntries).toBeUndefined()
  })

  it('both spot feeds down: refused, no price is made up', async () => {
    down.spot = true
    const { status, body } = await cosign()
    expect(status).toBe(503)
    expect(body.code).toBe('price_feed_unavailable')
    expect(body.authEntries).toBeUndefined()
  })

  it('database down: the wallet and strike allowances are unread, so refused', async () => {
    down.db = true
    const { status, body } = await cosign()
    expect(status).toBe(503)
    expect(body.code).toBe('limit_check_unavailable')
    expect(body.authEntries).toBeUndefined()
  })

  it('every volatility source down with nothing cached: refused, no σ is made up', async () => {
    down.sigma = true
    const { status, body } = await cosign()
    expect(status).toBe(500)
    expect(body.authEntries).toBeUndefined()
  })

  it('Soroban RPC down before the limits were ever read: refused', async () => {
    down.limitsRpc = true
    const { status, body } = await cosign()
    expect(status).toBe(503)
    expect(body.code).toBe('limits_unreconciled')
    expect(body.authEntries).toBeUndefined()
  })

  it('Soroban RPC down after a clean read: rides out the grace, then refuses', async () => {
    // Documented in lib/vault-limits: a transport blip is not drift, so a
    // clean reading is served for up to an hour. The contract's own Limits
    // still bind every write in that hour; this only decides whether the desk
    // keeps quoting inside them.
    const { reconcileLimits } = await import('../vault-limits')
    const { XLM } = await import('../assets')
    const t0 = Date.now()
    expect((await reconcileLimits(XLM, t0)).ok).toBe(true)

    down.limitsRpc = true
    const inGrace = await reconcileLimits(XLM, t0 + 10 * 60_000)
    expect(inGrace).toMatchObject({ ok: true, stale: true })

    const pastGrace = await reconcileLimits(XLM, t0 + 61 * 60_000)
    expect(pastGrace.ok).toBe(false)
  })
})

describe('the utilization read with the database down', () => {
  it('prices against a nearly full pool, which pays less, never more', async () => {
    const { expiryUtilizationFor } = await import('../vault-state')
    const { XLM } = await import('../assets')
    const expiry = new Date(Date.now() + 10 * 86_400_000).toISOString()

    const up = await expiryUtilizationFor('call', expiry, XLM)
    down.db = true
    const blind = await expiryUtilizationFor('call', expiry, XLM)

    expect(blind).toBe(0.98)
    expect(blind).toBeGreaterThan(up)
  })
})
