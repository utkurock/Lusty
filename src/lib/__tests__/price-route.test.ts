import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

// The price endpoint, asked which asset it is quoting.
//
// It used to be /api/price/xlm with the ticker written into it, which was
// honest while there was one underlying. The danger in generalising it badly is
// specific: a BTC screen served XLM's price is not a little wrong, it is wrong
// by a factor of four hundred thousand, and every USD figure derived from it —
// the value of a deposit, the cap it counts against — is wrong with it while
// looking like an ordinary number.

const getSpot = vi.fn()
vi.mock('@/lib/spot', () => ({ getSpot: (...a: any[]) => getSpot(...a) }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }))

let price: typeof import('@/app/api/price/[asset]/route')

beforeAll(async () => {
  price = await import('@/app/api/price/[asset]/route')
})

beforeEach(() => {
  getSpot.mockReset()
  getSpot.mockResolvedValue({ price: 0.25, source: 'reflector', asOf: 1 })
  // The 24h change is best-effort and from third parties; neither is reachable
  // here, so every test below is about the price itself.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 451 }) as any))
})

const get = (asset: string) =>
  price.GET(new Request(`https://vault.test/api/price/${asset}`), {
    params: Promise.resolve({ asset }),
  })

describe('spot per underlying', () => {
  it('quotes the asset it was asked for', async () => {
    const res = await get('xlm')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.asset).toBe('XLM')
    expect(body.price).toBe(0.25)
    // Not "a spot price" — the registry entry, so the feed and the ticker
    // behind the number are the asset's own.
    expect(getSpot.mock.calls[0][0].symbol).toBe('XLM')
  })

  it('refuses an asset it cannot quote rather than answering with XLM', async () => {
    // BTC is declared but gated in a test environment: no issuer, no instance.
    const res = await get('btc')
    expect(res.status).toBe(404)
    expect(getSpot).not.toHaveBeenCalled()
  })

  it('refuses a symbol that is not an underlying at all', async () => {
    const res = await get('doge')
    expect(res.status).toBe(404)
  })
})
