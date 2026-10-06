import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getRealizedVol, resetVolCache, MAX_STALE_SIGMA_MS } from '../vol'
import { getForward, resetForwardCache, MAX_STALE_FUNDING_MS } from '../forward'

const CG = (n: number) =>
  ({ ok: true, json: async () => ({ prices: Array.from({ length: n }, (_, i) => [i, 0.2 + i * 0.001]) }) }) as any

describe('dead-feed cooldowns', () => {
  beforeEach(() => { resetVolCache(); resetForwardCache() })
  afterEach(() => { vi.restoreAllMocks() })

  it('vol: stops dialling binance after it fails once', async () => {
    let binanceCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      if (String(url).includes('binance')) { binanceCalls++; throw new Error('connect timeout') }
      return CG(60)
    }))
    const t0 = Date.now()
    await getRealizedVol(undefined, t0)
    // σ cache expired (6 min later) but the cooldown (10 min) has not.
    await getRealizedVol(undefined, t0 + 6 * 60_000)
    expect(binanceCalls).toBe(1)
    // Past the cooldown it is tried again.
    await getRealizedVol(undefined, t0 + 21 * 60_000)
    expect(binanceCalls).toBe(2)
  })

  it('forward: falls back to F=S and stops dialling the perp', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => { calls++; throw new Error('connect timeout') }))
    const t0 = Date.now()
    const a = await getForward(0.2, 0.03, undefined, t0)
    expect(a.source).toBe('spot-fallback')
    expect(a.forward).toBe(0.2)
    await getForward(0.2, 0.03, undefined, t0 + 5_000)
    await getForward(0.2, 0.03, undefined, t0 + 30_000)
    expect(calls).toBe(1)
    await getForward(0.2, 0.03, undefined, t0 + 61_000)
    expect(calls).toBe(2)
  })
})

describe('realized-vol source order', () => {
  beforeEach(() => { resetVolCache() })
  afterEach(() => { vi.restoreAllMocks() })

  const series = (n: number, shape: 'coingecko' | 'bitstamp') =>
    shape === 'coingecko'
      ? { ok: true, json: async () => ({ prices: Array.from({ length: n }, (_, i) => [i, 0.2 + i * 0.001]) }) }
      : { ok: true, json: async () => ({ data: { ohlc: Array.from({ length: n }, (_, i) => ({ close: String(0.2 + i * 0.001) })) } }) }

  it('falls to bitstamp when binance is unreachable, before coingecko is asked', async () => {
    let coingeckoCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      const u = String(url)
      if (u.includes('binance')) throw new Error('connect timeout')
      if (u.includes('coingecko')) { coingeckoCalls++; return series(60, 'coingecko') as any }
      return series(60, 'bitstamp') as any
    }))
    const vol = await getRealizedVol(undefined, Date.now())
    expect(vol.method).toContain('bitstamp')
    expect(coingeckoCalls).toBe(0)
  })

  it('still reaches coingecko when bitstamp is down too', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      const u = String(url)
      if (u.includes('coingecko')) return series(60, 'coingecko') as any
      throw new Error('connect timeout')
    }))
    const vol = await getRealizedVol(undefined, Date.now())
    expect(vol.method).toContain('coingecko')
  })

  it('fails closed only when every source is gone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect timeout') }))
    await expect(getRealizedVol(undefined, Date.now())).rejects.toThrow(/no price history/)
  })
})

describe('stale inputs have an age limit', () => {
  beforeEach(() => { resetVolCache(); resetForwardCache() })
  afterEach(() => { vi.restoreAllMocks() })

  // σ used to be served from the last good reading for as long as every
  // history source stayed down, with no bound at all. A process up through a
  // week-long block priced every quote off a week-old regime.
  it('vol: rides out an outage on the last σ, then fails closed past a day', async () => {
    let up = true
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (!up) throw new Error('connect timeout')
      return CG(60)
    }))
    const t0 = Date.now()
    const fresh = await getRealizedVol(undefined, t0)

    up = false
    const hourLater = await getRealizedVol(undefined, t0 + 3600_000)
    expect(hourLater.sigma).toBe(fresh.sigma)

    await expect(
      getRealizedVol(undefined, t0 + MAX_STALE_SIGMA_MS + 60_000),
    ).rejects.toThrow(/no price history/)
  })

  it('forward: keeps the last carry through a short outage, then rolls at F = S', async () => {
    let up = true
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (!up) throw new Error('connect timeout')
      return { ok: true, json: async () => ({ lastFundingRate: '0.0001' }) } as any
    }))
    const t0 = Date.now()
    expect((await getForward(0.2, 0.03, undefined, t0)).source).toBe('perp-funding')

    up = false
    expect((await getForward(0.2, 0.03, undefined, t0 + 120_000)).source).toBe('perp-funding')

    const late = await getForward(0.2, 0.03, undefined, t0 + MAX_STALE_FUNDING_MS + 120_000)
    expect(late.source).toBe('spot-fallback')
    expect(late.forward).toBe(0.2)
  })
})
