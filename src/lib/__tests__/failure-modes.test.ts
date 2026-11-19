import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { Horizon, Keypair, StrKey } from '@stellar/stellar-sdk'

// Failure modes: one outside dependency down at a time.
// =====================================================
// docs/FAILURE-MODES.md is the table; this file is what keeps it true. Each
// block takes exactly one of the five things the product leans on and cannot
// run itself (the Reflector oracle, the settlement runner, Horizon, the Soroban
// RPC and Binance) out of service, leaves the other four healthy, and asserts
// both columns of its row: what stops, and what keeps working.
//
// The fakes sit at the network edge, never inside the logic being described:
// the oracle and the RPC at the module that talks to them, Horizon at the SDK,
// and Binance, CoinGecko and Bitstamp at `fetch`. Everything between those
// edges and the assertion is the code that runs in production.
//
// The co-signature's own one-at-a-time matrix (breaker, database, feeds,
// limits, pause) is outage-fail-closed.test.ts; this one is per dependency and
// covers settlement and the market inputs as well.

const XLM_VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x11))
const WRITER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x66))

const deps = vi.hoisted(() => ({
  oracle: true,
  rpc: true,
  horizon: true,
  binance: true,
}))

const reset = () => {
  deps.oracle = true
  deps.rpc = true
  deps.horizon = true
  deps.binance = true
}

const ORACLE_SPOT = 0.25
const BINANCE_SPOT = 0.27

vi.mock('@/lib/reflector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../reflector')>()),
  reflectorLastPriceRecord: async () => {
    if (!deps.oracle) throw new Error('reflector: simulation failed')
    return { price: ORACLE_SPOT, timestamp: Math.floor(Date.now() / 1000) }
  },
}))

// Settlement and the instance reads both go through the RPC; settlement also
// needs the oracle's period record, which the contract reads itself and
// refuses (#7) when it is missing.
const rpcDown = () => new Error('soroban rpc: 503 Service Unavailable')
vi.mock('@/lib/vault-contract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../vault-contract')>()),
  getVaultLimits: async (asset: any) => {
    if (!deps.rpc) throw rpcDown()
    return asset.onchainLimits
  },
  getVaultPaused: async () => {
    if (!deps.rpc) throw rpcDown()
    return false
  },
  settlePosition: async (id: number) => {
    if (!deps.rpc) throw rpcDown()
    if (!deps.oracle) throw new Error('No oracle price available')
    return { txHash: `settle-${id}`, outcome: 'kept' }
  },
  recordExpiryPrice: async () => {
    if (!deps.rpc || !deps.oracle) throw rpcDown()
    return 'recorded'
  },
}))

vi.spyOn(Horizon.Server.prototype, 'loadAccount').mockImplementation(async () => {
  if (!deps.horizon) {
    throw Object.assign(new Error('Request failed with status code 503'), {
      response: { status: 503 },
    })
  }
  return { balances: [] } as any
})

// Thirty daily closes with some movement, so σ is a real number.
const CLOSES = Array.from({ length: 31 }, (_, i) => 0.25 * (1 + 0.02 * Math.sin(i)))

const realFetch = globalThis.fetch
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input)
  const host = new URL(url).host
  if (host.endsWith('binance.com')) {
    if (!deps.binance) throw new TypeError('fetch failed')
    if (url.includes('/ticker/price')) return json({ price: String(BINANCE_SPOT) })
    if (url.includes('/klines')) return json(CLOSES.map((c, i) => [i, '0', '0', '0', String(c)]))
    if (url.includes('/premiumIndex')) return json({ lastFundingRate: '0.0001' })
  }
  if (host === 'api.coingecko.com') return json({ prices: CLOSES.map((c, i) => [i * 86_400_000, c]) })
  if (host === 'www.bitstamp.net') return json({ data: { ohlc: CLOSES.map((c) => ({ close: String(c) })) } })
  return json({ error: `unexpected ${url}` }, 404)
}

type Spot = typeof import('../spot')
type Vol = typeof import('../vol')
type Fwd = typeof import('../forward')
type Lim = typeof import('../vault-limits')
type Settle = typeof import('../settlement')
type Swap = typeof import('../swap')
type Assets = typeof import('../assets')
let spot: Spot
let vol: Vol
let fwd: Fwd
let lim: Lim
let settle: Settle
let swap: Swap
let reg: Assets

beforeAll(async () => {
  process.env.NEXT_PUBLIC_VAULT_CONTRACT = XLM_VAULT
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  spot = await import('../spot')
  vol = await import('../vol')
  fwd = await import('../forward')
  lim = await import('../vault-limits')
  settle = await import('../settlement')
  swap = await import('../swap')
  reg = await import('../assets')
})

afterAll(() => {
  vi.stubGlobal('fetch', realFetch)
})

beforeEach(() => {
  reset()
  spot.resetSpotCache()
  vol.resetVolCache()
  fwd.resetForwardCache()
  lim.resetLimitsCache()
  settle.resetSettlementMemory()
})

/** One expired XLM position, inside or past its oracle window. */
function candidate(id: number, pastDeadline = false): import('../settlement').SettlementCandidate {
  const expiry = new Date(Date.now() - 3_600_000)
  return {
    id,
    underlying: 'XLM',
    vault: XLM_VAULT,
    owner: WRITER,
    side: 'call',
    strike: 0.3,
    collateral: 100,
    expiry,
    settleBy: new Date(expiry.getTime() + (pastDeadline ? -1 : 1) * 86_400_000),
    pastDeadline,
  }
}

const runner = Keypair.random()

describe('baseline: everything up', () => {
  it('prices off the oracle, settles, and reconciles the book', async () => {
    expect((await spot.getSpot(reg.XLM)).source).toBe('reflector')
    expect((await settle.runSettlement([candidate(1)], runner)).settled).toHaveLength(1)
    expect(await lim.limitsRefusal(reg.XLM)).toBeNull()
    expect(await lim.pauseRefusal(reg.XLM)).toBeNull()
  })
})

describe('the Reflector oracle is down', () => {
  beforeEach(() => {
    deps.oracle = false
  })

  it('keeps quoting: spot falls back to Binance', async () => {
    const s = await spot.getSpot(reg.XLM)
    expect(s).toMatchObject({ source: 'binance', price: BINANCE_SPOT })
  })

  it('stops settlement, and reports it as something to wait out', async () => {
    const run = await settle.runSettlement([candidate(1)], runner)
    expect(run.settled).toHaveLength(0)
    expect(run.failed).toHaveLength(1)
    expect(run.failed[0].permanent).toBe(false)
    expect(run.pricesRecorded).toHaveLength(0)
  })

  it('with Binance down as well, refuses to price at all rather than invent a spot', async () => {
    deps.binance = false
    await expect(spot.getSpot(reg.XLM)).rejects.toThrow('price feed unavailable')
  })
})

describe('the settlement runner is down', () => {
  // Nothing in the product settles on its own: a runner that does not run
  // leaves expired positions open. What it cannot do is change who may settle
  // or at what price, because `settle` is permissionless and prices itself.
  it('stops nothing that any other key cannot do: a stranger settles the same position', async () => {
    const stranger = Keypair.random()
    const run = await settle.runSettlement([candidate(7)], stranger)
    expect(run.settled).toEqual([expect.objectContaining({ id: 7, outcome: 'kept' })])
  })

  it('a late run still reaches a position inside its window before one past it', () => {
    const order = settle.prioritize([candidate(1, true), candidate(2)])
    expect(order.map((c) => c.id)).toEqual([2, 1])
  })

  it('a position left past its oracle window fails as permanent, the case that needs a person', async () => {
    deps.oracle = false
    const run = await settle.runSettlement([candidate(3, true)], runner)
    expect(run.failed[0]).toMatchObject({ id: 3, permanent: true })
  })
})

describe('Horizon is down', () => {
  beforeEach(() => {
    deps.horizon = false
  })

  it('stops the trustline check, as an outage rather than as "no trustline"', async () => {
    const lbtc = { kind: 'issued', code: 'LBTC', issuer: Keypair.random().publicKey() } as any
    await expect(swap.hasTrustline(WRITER, lbtc)).rejects.toBeInstanceOf(swap.TrustlineCheckUnavailable)
  })

  it('keeps the XLM book writable: native XLM needs no Horizon read', async () => {
    expect(await swap.hasTrustline(WRITER, reg.XLM.stellarAsset)).toBe(true)
  })

  it('keeps quoting and settling, which never read Horizon', async () => {
    expect((await spot.getSpot(reg.XLM)).source).toBe('reflector')
    expect((await settle.runSettlement([candidate(1)], runner)).settled).toHaveLength(1)
  })
})

describe('the Soroban RPC is down', () => {
  it('keeps quoting on the last clean reading of the limits and the pause, inside the grace', async () => {
    const t0 = Date.now()
    expect(await lim.limitsRefusal(reg.XLM, t0)).toBeNull()
    expect(await lim.pauseRefusal(reg.XLM, t0)).toBeNull()
    deps.rpc = false
    expect(await lim.limitsRefusal(reg.XLM, t0 + 30 * 60_000)).toBeNull()
    expect(await lim.pauseRefusal(reg.XLM, t0 + 30 * 60_000)).toBeNull()
  })

  it('stops the book once no clean reading is left to stand on', async () => {
    const t0 = Date.now()
    await lim.limitsRefusal(reg.XLM, t0)
    deps.rpc = false
    expect(await lim.limitsRefusal(reg.XLM, t0 + 2 * 3_600_000)).toContain('could not be read')
    expect(await lim.pauseRefusal(reg.XLM, t0 + 2 * 3_600_000)).toContain('could not be read')
  })

  it('stops a book that was never read at all', async () => {
    deps.rpc = false
    expect(await lim.limitsRefusal(reg.XLM)).toContain('could not be read')
  })

  it('stops settlement, and leaves the position for the next run', async () => {
    deps.rpc = false
    const run = await settle.runSettlement([candidate(1)], runner)
    expect(run.settled).toHaveLength(0)
    expect(run.failed[0].permanent).toBe(false)
  })

  it('keeps live spot: Binance answers when the oracle cannot be simulated', async () => {
    deps.rpc = false
    deps.oracle = false // the oracle is read over the same RPC
    expect((await spot.getSpot(reg.XLM)).source).toBe('binance')
  })
})

describe('Binance is down', () => {
  beforeEach(() => {
    deps.binance = false
  })

  it('keeps spot on the oracle', async () => {
    expect(await spot.getSpot(reg.XLM)).toMatchObject({ source: 'reflector', price: ORACLE_SPOT })
  })

  it('keeps σ from the next daily-close source', async () => {
    const v = await vol.getRealizedVol(reg.XLM)
    expect(v.sigma).toBeGreaterThan(0)
    expect(v.method).toMatch(/coingecko|bitstamp/i)
  })

  it('keeps the forward, at F = S with no funding invented', async () => {
    const f = await fwd.getForward(ORACLE_SPOT, 30 / 365, reg.XLM)
    expect(f).toMatchObject({ source: 'spot-fallback', forward: ORACLE_SPOT, fundingAnnual: 0 })
  })

  it('stops nothing on the money path', async () => {
    expect(await lim.limitsRefusal(reg.XLM)).toBeNull()
    expect((await settle.runSettlement([candidate(1)], runner)).settled).toHaveLength(1)
  })
})
