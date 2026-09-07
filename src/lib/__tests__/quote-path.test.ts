import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { XLM, BTC } from '../assets'
import { getRealizedVol, resetVolCache } from '../vol'
import { getForward, resetForwardCache } from '../forward'
import { getMarketContext, quoteLadder, quoteOptionLive } from '../pricing-server'

// Two price series with plainly different volatility, so a σ read off the
// wrong one cannot pass for the right one.
const STEADY = Array.from({ length: 61 }, (_, i) => 100 + i * 0.01)
const JUMPY = Array.from({ length: 61 }, (_, i) => 100 * (i % 2 ? 1.06 : 0.94))

const klines = (closes: number[]) => closes.map((c) => [0, '0', '0', '0', String(c)])

/** Answers each upstream by URL, and records every URL asked for. */
function stubFeeds(spec: {
  klines?: Record<string, number[]>
  funding?: Record<string, number>
}) {
  const asked: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any) => {
      const url = String(input)
      asked.push(url)
      const symbol = new URL(url).searchParams.get('symbol') ?? ''
      if (url.includes('/klines')) {
        const closes = spec.klines?.[symbol]
        if (!closes) return { ok: false, status: 451 } as any
        return { ok: true, json: async () => klines(closes) } as any
      }
      if (url.includes('premiumIndex')) {
        const rate = spec.funding?.[symbol]
        if (rate === undefined) return { ok: false, status: 451 } as any
        return { ok: true, json: async () => ({ lastFundingRate: String(rate) }) } as any
      }
      // CoinGecko and anything else: unreachable, so the test never silently
      // passes on a fallback it did not intend to exercise.
      return { ok: false, status: 404 } as any
    }),
  )
  return asked
}

beforeEach(() => {
  resetVolCache()
  resetForwardCache()
})
afterEach(() => vi.unstubAllGlobals())

describe('realized vol comes from the underlying s own history', () => {
  it('reads each asset s own ticker', async () => {
    const asked = stubFeeds({ klines: { XLMUSDT: STEADY, BTCUSDT: JUMPY } })

    const xlm = await getRealizedVol(XLM)
    const btc = await getRealizedVol(BTC)

    expect(asked.some((u) => u.includes('symbol=XLMUSDT'))).toBe(true)
    expect(asked.some((u) => u.includes('symbol=BTCUSDT'))).toBe(true)
    expect(btc.sigma).toBeGreaterThan(xlm.sigma * 10)
    expect(xlm.method).toContain('XLMUSDT')
    expect(btc.method).toContain('BTCUSDT')
  })

  it('does not serve one asset s sigma out of another s cache slot', async () => {
    stubFeeds({ klines: { XLMUSDT: STEADY, BTCUSDT: JUMPY } })
    const first = await getRealizedVol(XLM)
    // Same instant, so a shared slot would still be fresh and would answer.
    const second = await getRealizedVol(BTC)
    expect(second.sigma).not.toBe(first.sigma)
  })

  it('refuses rather than falling back to the other asset when its feeds are down', async () => {
    stubFeeds({ klines: { XLMUSDT: STEADY } })
    await getRealizedVol(XLM)
    await expect(getRealizedVol(BTC)).rejects.toThrow(/BTC/)
  })
})

describe('the forward rolls each spot at its own carry', () => {
  it('reads each asset s own perp', async () => {
    const asked = stubFeeds({ funding: { XLMUSDT: 0.0001, BTCUSDT: 0.001 } })

    const xlm = await getForward(1, 1, XLM)
    const btc = await getForward(1, 1, BTC)

    expect(asked.filter((u) => u.includes('premiumIndex')).length).toBe(2)
    expect(btc.fundingAnnual).toBeCloseTo(0.001 * 3 * 365, 9)
    expect(xlm.fundingAnnual).toBeCloseTo(0.0001 * 3 * 365, 9)
    expect(btc.forward).toBeGreaterThan(xlm.forward)
  })

  it('falls back to F = S rather than borrowing another asset s funding', async () => {
    stubFeeds({ funding: { XLMUSDT: 0.001 } })
    await getForward(1, 1, XLM)

    const btc = await getForward(50_000, 1, BTC)
    expect(btc.source).toBe('spot-fallback')
    expect(btc.forward).toBe(50_000)
    expect(btc.fundingAnnual).toBe(0)
  })
})

describe('a BTC quote is priced off BTC inputs', () => {
  it('carries the asset from the quote call to both feeds', async () => {
    const asked = stubFeeds({
      klines: { XLMUSDT: STEADY, BTCUSDT: JUMPY },
      funding: { XLMUSDT: 0.0001, BTCUSDT: 0.001 },
    })

    const ctx = await getMarketContext(77_000, 7, BTC)

    expect(asked.every((u) => !u.includes('XLMUSDT'))).toBe(true)
    expect(ctx.volMethod).toContain('BTCUSDT')
    expect(ctx.forwardSource).toBe('perp-funding')
    expect(ctx.sigmaRealized).toBe((await getRealizedVol(BTC)).sigma)
  })

  it('prices the same strike differently for two assets', async () => {
    stubFeeds({
      klines: { XLMUSDT: STEADY, BTCUSDT: JUMPY },
      funding: { XLMUSDT: 0.0001, BTCUSDT: 0.001 },
    })

    const shared = { side: 'call' as const, spot: 100, strike: 105, daysToExpiry: 7 }
    const asXlm = await quoteOptionLive({ ...shared, asset: XLM })
    const asBtc = await quoteOptionLive({ ...shared, asset: BTC })

    // Same spot, same strike, same tenor. Only σ and the carry differ, and
    // they are enough — a premium that matched would mean one of them was
    // priced off the other's market.
    expect(asBtc.quote.userPremium).toBeGreaterThan(asXlm.quote.userPremium)
  })

  it('still prices XLM when no asset is named', async () => {
    const asked = stubFeeds({
      klines: { XLMUSDT: STEADY, BTCUSDT: JUMPY },
      funding: { XLMUSDT: 0.0001 },
    })
    const ctx = await getMarketContext(0.25, 7)
    expect(ctx.volMethod).toContain('XLMUSDT')
    expect(asked.every((u) => !u.includes('BTCUSDT'))).toBe(true)
  })
})

describe('shown equals paid, for both assets', () => {
  it('reprices every rung of the ladder to the premium it displayed', async () => {
    stubFeeds({
      klines: { XLMUSDT: STEADY, BTCUSDT: JUMPY },
      funding: { XLMUSDT: 0.0001, BTCUSDT: 0.001 },
    })

    // The two calls the money path actually makes: the ladder the earn screen
    // renders, then the single-strike repricing the co-signature runs before
    // it will sign. They must land on the same number for the same rung.
    for (const asset of [XLM, BTC]) {
      const { rungs } = await quoteLadder('call', 100, 7, 0.4, asset)
      expect(rungs.length).toBeGreaterThan(0)

      for (const rung of rungs) {
        const { quote } = await quoteOptionLive({
          side: 'call',
          spot: 100,
          strike: rung.strike,
          daysToExpiry: 7,
          utilization: 0.4,
          asset,
        })
        expect(quote.userPremium).toBe(rung.userPremium)
        expect(quote.apr).toBe(rung.apr)
      }
    }
  })
})
