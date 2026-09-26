import { describe, it, expect, beforeEach } from 'vitest'
import { XLM, BTC } from '../assets'
import {
  headroom,
  inFlight,
  release,
  reserve,
  resetRoutingBudget,
  routingExposure,
  RoutingCapExceeded,
} from '../routing/budget'

const NOW = 1_700_000_000_000

beforeEach(() => resetRoutingBudget())

describe('a book can only have so much in flight at once', () => {
  it('starts empty and opens with its whole declared cap', () => {
    expect(inFlight('XLM', NOW)).toBe(0)
    expect(headroom(XLM, NOW)).toBe(XLM.routedCapUsd)
  })

  it('refuses the swap that would take it over, not the one that fills it', () => {
    reserve(XLM, XLM.routedCapUsd - 100, NOW)
    expect(() => reserve(XLM, 100, NOW)).not.toThrow()
    expect(headroom(XLM, NOW)).toBe(0)
    expect(() => reserve(XLM, 0.0000001, NOW)).toThrow(RoutingCapExceeded)
  })

  it('says what is left rather than only that it refused', () => {
    reserve(XLM, XLM.routedCapUsd - 250, NOW)
    try {
      reserve(XLM, 400, NOW)
      throw new Error('should have refused')
    } catch (e: any) {
      expect(e).toBeInstanceOf(RoutingCapExceeded)
      expect(e.available).toBeCloseTo(250, 7)
      expect(e.requested).toBe(400)
      expect(e.cap).toBe(XLM.routedCapUsd)
      expect(e.message).toMatch(/available/)
    }
  })

  it('refuses an amount that is not one', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(() => reserve(XLM, bad, NOW)).toThrow(RoutingCapExceeded)
    }
  })
})

describe('two swaps a second apart cannot each see an empty book', () => {
  it('counts a reservation against the next one immediately', () => {
    // The failure this exists for. Checking the cap and then forgetting is the
    // same as having no cap: every concurrent swap reads the same zero.
    const first = reserve(XLM, XLM.routedCapUsd, NOW)
    expect(() => reserve(XLM, 1, NOW + 1)).toThrow(RoutingCapExceeded)
    release(first)
    expect(() => reserve(XLM, 1, NOW + 2)).not.toThrow()
  })

  it('gives the capacity back when a swap resolves, either way', () => {
    const r = reserve(XLM, 5_000, NOW)
    expect(inFlight('XLM', NOW)).toBe(5_000)
    release(r)
    expect(inFlight('XLM', NOW)).toBe(0)
  })

  it('tolerates a release that already happened, or never needed to', () => {
    // The error path calls this without knowing which state it is in.
    const r = reserve(XLM, 100, NOW)
    release(r)
    expect(() => release(r)).not.toThrow()
    expect(() => release(null)).not.toThrow()
    expect(inFlight('XLM', NOW)).toBe(0)
  })
})

describe('a crashed swap does not hold a book hostage', () => {
  it('lapses on its own rather than waiting for a deploy', () => {
    reserve(XLM, XLM.routedCapUsd, NOW)
    expect(headroom(XLM, NOW + 119_000)).toBe(0)
    expect(headroom(XLM, NOW + 121_000)).toBe(XLM.routedCapUsd)
  })
})

describe('one book s routing does not touch another s', () => {
  it('fills XLM to the brim and leaves BTC untouched', () => {
    // The same separation the escrow and the caps have. Two books, two bounds.
    reserve(XLM, XLM.routedCapUsd, NOW)
    expect(headroom(XLM, NOW)).toBe(0)
    expect(headroom(BTC, NOW)).toBe(BTC.routedCapUsd)
    expect(() => reserve(BTC, BTC.routedCapUsd, NOW)).not.toThrow()
  })

  it('reports each book s exposure separately', () => {
    reserve(BTC, BTC.routedCapUsd / 2, NOW)
    const rows = routingExposure([XLM, BTC], NOW)
    expect(rows.find((r) => r.book === 'XLM')!.pctFull).toBe(0)
    expect(rows.find((r) => r.book === 'BTC')!.pctFull).toBeCloseTo(50, 7)
  })
})

describe('every book declares a bound that can actually be met', () => {
  it('leaves room for at least one full position s cash', () => {
    // A cap below one position is a bound no route could ever satisfy, which is
    // why validation refuses the declaration rather than leaving it to be
    // discovered by the first writer who tries.
    for (const asset of [XLM, BTC]) {
      expect(asset.routedCapUsd).toBeGreaterThanOrEqual(asset.maxSizeCash)
    }
  })
})
