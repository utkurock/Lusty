import { describe, it, expect } from 'vitest'
import {
  routes,
  routeFor,
  routeById,
  allowedAssets,
  isAllowedAsset,
  pathRefusal,
  sameAsset,
  type RoutedAsset,
} from '../routing/allowlist'
import { LUSD_CODE, LUSD_ISSUER } from '../lusd'
import { USDC_CODE, USDC_ISSUER } from '../usdc'

const LUSD: RoutedAsset = { code: LUSD_CODE, issuer: LUSD_ISSUER }
const USDC: RoutedAsset = { code: USDC_CODE, issuer: USDC_ISSUER }
// The asset this file exists to keep out: right code, wrong issuer.
const FAKE_USDC: RoutedAsset = {
  code: 'USDC',
  issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLXXXX',
}
const RANDOM: RoutedAsset = {
  code: 'SHIB',
  issuer: 'GDXUHMT3QELEW6YBKSYXJBBXINUWA2MFR26RIS6C332N25EYU3D6CJ4V',
}
const NATIVE: RoutedAsset = { code: 'XLM', issuer: null }

describe('an asset is its code AND its issuer', () => {
  it('does not confuse two assets that share a code', () => {
    expect(sameAsset(USDC, USDC)).toBe(true)
    expect(sameAsset(USDC, FAKE_USDC)).toBe(false)
  })

  it('treats a missing issuer and a null issuer as the same native asset', () => {
    expect(sameAsset(NATIVE, { code: 'XLM', issuer: null })).toBe(true)
    expect(sameAsset(NATIVE, { code: 'XLM' } as RoutedAsset)).toBe(true)
  })
})

describe('anything not on the list is not a route', () => {
  it('declares the pair, both ways', () => {
    expect(routes().map((r) => r.id).sort()).toEqual(['lusd->usdc', 'usdc->lusd'])
    expect(routeFor(USDC, LUSD)?.id).toBe('usdc->lusd')
    expect(routeFor(LUSD, USDC)?.id).toBe('lusd->usdc')
  })

  it('has no route for an asset nobody declared', () => {
    expect(routeFor(RANDOM, LUSD)).toBeNull()
    expect(routeFor(LUSD, RANDOM)).toBeNull()
    expect(routeFor(NATIVE, LUSD)).toBeNull()
  })

  it('has no route for a lookalike issuer', () => {
    // The whole reason an asset is a pair. A route keyed on the code alone
    // would send the writer's dollars into a token anyone can mint.
    expect(routeFor(FAKE_USDC, LUSD)).toBeNull()
    expect(isAllowedAsset(FAKE_USDC)).toBe(false)
    expect(isAllowedAsset(USDC)).toBe(true)
  })

  it('has no route from an asset to itself', () => {
    expect(routeFor(LUSD, LUSD)).toBeNull()
  })

  it('answers for an id nobody declared without inventing one', () => {
    expect(routeById('usdc->shib')).toBeNull()
    expect(routeById('')).toBeNull()
    expect(routeById('constructor')).toBeNull()
  })
})

describe('the bounds every route carries', () => {
  it('bounds slippage, quote age and notional on every declared route', () => {
    for (const r of routes()) {
      expect(r.maxSlippageBps).toBeGreaterThan(0)
      expect(r.maxSlippageBps).toBeLessThanOrEqual(10_000)
      expect(r.quoteMaxAgeMs).toBeGreaterThan(0)
      expect(r.maxNotional).toBeGreaterThan(0)
      expect(r.maxHops).toBeGreaterThanOrEqual(0)
    }
  })

  it('allows only the assets the declared routes name', () => {
    expect(allowedAssets()).toHaveLength(2)
    expect(allowedAssets().every(isAllowedAsset)).toBe(true)
  })
})

describe('a path is only as good as the assets in it', () => {
  const route = routeFor(USDC, LUSD)!

  it('takes a direct path', () => {
    expect(pathRefusal(route, [])).toBeNull()
  })

  it('refuses a path through an asset nobody allowlisted', () => {
    // The failure this guards is the path finder doing its job: it returns
    // whatever fills cheapest, and cheapest through a token with two offers in
    // it is a quote that evaporates — or an issuer who can freeze the balance
    // mid-path.
    const wide = { ...route, maxHops: 3 }
    expect(pathRefusal(wide, [RANDOM])).toMatch(/not on the allowlist/)
    expect(pathRefusal(wide, [LUSD, RANDOM])).toMatch(/SHIB/)
  })

  it('refuses a path longer than the route allows, even through allowed assets', () => {
    expect(pathRefusal(route, [LUSD])).toMatch(/direct only/)
    const oneHop = { ...route, maxHops: 1 }
    expect(pathRefusal(oneHop, [LUSD])).toBeNull()
    expect(pathRefusal(oneHop, [LUSD, USDC])).toMatch(/allows 1 intermediate/)
  })

  it('refuses a lookalike in the middle of an otherwise fine path', () => {
    const wide = { ...route, maxHops: 2 }
    expect(pathRefusal(wide, [FAKE_USDC])).toMatch(/not on the allowlist/)
  })
})
