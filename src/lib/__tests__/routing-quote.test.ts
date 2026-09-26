import { describe, it, expect, vi, afterEach } from 'vitest'
import { routeFor, type RoutedAsset } from '../routing/allowlist'
import {
  choosePath,
  isStale,
  quoteAge,
  quoteRoute,
  RouteRefused,
  type RouteQuote,
} from '../routing/quote'
import { LUSD_CODE, LUSD_ISSUER } from '../lusd'
import { USDC_CODE, USDC_ISSUER } from '../usdc'

const LUSD: RoutedAsset = { code: LUSD_CODE, issuer: LUSD_ISSUER }
const USDC: RoutedAsset = { code: USDC_CODE, issuer: USDC_ISSUER }
const ROUTE = routeFor(USDC, LUSD)!

/** One record shaped as Horizon returns them, with only the ends that matter. */
function record(over: Partial<any> = {}): any {
  return {
    source_asset_type: 'credit_alphanum4',
    source_asset_code: USDC.code,
    source_asset_issuer: USDC.issuer,
    source_amount: '100.0000000',
    destination_asset_type: 'credit_alphanum4',
    destination_asset_code: LUSD.code,
    destination_asset_issuer: LUSD.issuer,
    destination_amount: '100.0000000',
    path: [],
    ...over,
  }
}

const hop = (code: string, issuer: string | null) =>
  issuer === null
    ? { asset_type: 'native' }
    : { asset_type: 'credit_alphanum4', asset_code: code, asset_issuer: issuer }

afterEach(() => vi.restoreAllMocks())

describe('choosePath takes the cheapest path the allowlist permits', () => {
  it('takes the cheapest of several direct paths', () => {
    const chosen = choosePath(ROUTE, [
      record({ source_amount: '101.0000000' }),
      record({ source_amount: '99.5000000' }),
      record({ source_amount: '100.2500000' }),
    ])
    expect(chosen.sendAmount).toBeCloseTo(99.5, 7)
    expect(chosen.hops).toEqual([])
  })

  it('refuses when nothing fills, rather than returning a worse number', () => {
    expect(() => choosePath(ROUTE, [])).toThrow(RouteRefused)
    try {
      choosePath(ROUTE, [])
    } catch (e: any) {
      expect(e.code).toBe('no_liquidity')
    }
  })

  it('skips a cheaper path through an asset nobody allowlisted', () => {
    // The whole point of the allowlist, and the case a cost-ranked finder walks
    // straight into: the cheapest fill here goes through a token with two
    // offers in it, whose issuer can freeze the balance mid-path.
    const chosen = choosePath(ROUTE, [
      record({
        source_amount: '90.0000000',
        path: [hop('SHIB', 'GDXUHMT3QELEW6YBKSYXJBBXINUWA2MFR26RIS6C332N25EYU3D6CJ4V')],
      }),
      record({ source_amount: '100.0000000' }),
    ])
    expect(chosen.sendAmount).toBeCloseTo(100, 7)
    expect(chosen.hops).toEqual([])
  })

  it('refuses when every path it was offered goes somewhere it may not', () => {
    // A route wide enough that the length bound is not what refuses this —
    // otherwise the test passes on the hop count and never reaches the
    // allowlist, which is the rule it is about.
    const oneHop = { ...ROUTE, maxHops: 1 }
    try {
      choosePath(oneHop, [
        record({
          source_amount: '90.0000000',
          path: [hop('SHIB', 'GDXUHMT3QELEW6YBKSYXJBBXINUWA2MFR26RIS6C332N25EYU3D6CJ4V')],
        }),
      ])
      throw new Error('should have refused')
    } catch (e: any) {
      expect(e).toBeInstanceOf(RouteRefused)
      expect(e.code).toBe('path_not_allowed')
      expect(e.message).toMatch(/SHIB/)
    }
  })

  it('refuses a path longer than the route allows even through allowed assets', () => {
    // Both ends are dollars. A path that needs to go through XLM to cross two
    // dollars is telling you the direct book is empty.
    try {
      choosePath(ROUTE, [record({ path: [hop('XLM', null)] })])
      throw new Error('should have refused')
    } catch (e: any) {
      expect(e.code).toBe('path_not_allowed')
      expect(e.message).toMatch(/direct only/)
    }
  })

  it('refuses a record about a pair it did not ask about', () => {
    try {
      choosePath(ROUTE, [
        record({ destination_asset_code: 'USDC', destination_asset_issuer: USDC.issuer }),
      ])
      throw new Error('should have refused')
    } catch (e: any) {
      expect(e.message).toMatch(/different pair/)
    }
  })

  it('refuses a lookalike issuer on the source side', () => {
    try {
      choosePath(ROUTE, [
        record({
          source_asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLXXXX',
        }),
      ])
      throw new Error('should have refused')
    } catch (e: any) {
      expect(e.message).toMatch(/different pair/)
    }
  })

  it('refuses a quoted cost that is not a number', () => {
    try {
      choosePath(ROUTE, [record({ source_amount: '0' })])
      throw new Error('should have refused')
    } catch (e: any) {
      expect(e).toBeInstanceOf(RouteRefused)
    }
  })
})

describe('a quote is refused before the network is asked', () => {
  it('refuses an amount that is not one', async () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      await expect(quoteRoute(ROUTE, bad)).rejects.toMatchObject({ code: 'invalid_amount' })
    }
  })

  it('refuses an amount above the route ceiling', async () => {
    await expect(quoteRoute(ROUTE, ROUTE.maxNotional + 1)).rejects.toMatchObject({
      code: 'above_notional',
    })
  })
})

describe('a quote is a reading, and readings go off', () => {
  const quote: RouteQuote = {
    route: ROUTE,
    destAmount: 100,
    sendAmount: 100.1,
    hops: [],
    quotedAt: 1_000_000,
  }

  it('measures its own age against the clock it is given', () => {
    expect(quoteAge(quote, 1_000_000)).toBe(0)
    expect(quoteAge(quote, 1_005_000)).toBe(5_000)
  })

  it('is fresh inside the route s bound and stale outside it', () => {
    const ms = ROUTE.quoteMaxAgeMs
    expect(isStale(quote, quote.quotedAt + ms)).toBe(false)
    expect(isStale(quote, quote.quotedAt + ms + 1)).toBe(true)
  })
})
