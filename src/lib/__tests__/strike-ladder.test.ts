import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StrKey } from '@stellar/stellar-sdk'
import { declare, type AssetDeclaration } from '../assets/schema'
import { XLM, BTC, type StrikeParams } from '../assets'
import { resetVolCache } from '../vol'
import { resetForwardCache } from '../forward'
import { quoteLadder, quoteOption } from '../pricing-server'
import { niceStrikeStep, roundStrike, strikeRungs } from '../pricing'

// M2-03. The ladder is the asset's, not the module's.
//
// Two things were global before this: which rungs a book offers, and how far a
// rung has to move before it rounds to a nicer number. Both were written for
// XLM, and both are meaningless transplanted: a 1% tick is $0.002 at $0.19 and
// $810 at $81,000, and a ladder is a claim about how far an underlying travels
// in a week. The declarations carry them per asset since M2-01; this is where
// lib/pricing reads them instead of its own constants.

const VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x31))
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 0x32))
const CASH = StrKey.encodeContract(Buffer.alloc(32, 0x33))

/** A declared book with a ladder nothing else in the repo uses. */
function book(symbol: string, strike: StrikeParams) {
  const d: AssetDeclaration = {
    symbol,
    name: `Test ${symbol}`,
    slug: symbol.toLowerCase(),
    icon: '◆',
    logo: `/${symbol.toLowerCase()}.png`,
    contracts: { vault: VAULT, token: TOKEN, cash: CASH },
    feedSymbol: symbol,
    binanceSymbol: `${symbol}USDT`,
    coingeckoId: symbol.toLowerCase(),
    collateral: { kind: 'native' },
    unitDecimals: 7,
    displayDecimals: 4,
    strike,
    expiry: { openExpiries: 3, minDaysToExpiry: 2, tenorDays: 7 },
    envelope: {
      minSize: 1,
      maxSize: 50,
      userEpochCall: 50,
      maxSizeCash: 500,
      userEpochPutUsd: 500,
      callMonthlyCap: 900,
      putMonthlyCapUsd: 9_000,
    },
    onchainLimits: {
      maxPositionCall: 50,
      maxPositionPut: 500,
      maxExpiryCall: 900,
      maxExpiryPut: 9_000,
      maxPremiumBps: 2_000,
    },
  }
  return declare(d)
}

const CLOSES = Array.from({ length: 61 }, (_, i) => 100 * (1 + 0.004 * Math.sin(i)))

/** Every book prices off one series, so a ladder difference is the only variable. */
function stubFeeds() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any) => {
      const url = String(input)
      if (url.includes('/klines')) {
        return {
          ok: true,
          json: async () => CLOSES.map((c) => [0, '0', '0', '0', String(c)]),
        } as any
      }
      if (url.includes('premiumIndex')) {
        return { ok: true, json: async () => ({ lastFundingRate: '0' }) } as any
      }
      return { ok: false, status: 404 } as any
    }),
  )
}

beforeEach(() => {
  resetVolCache()
  resetForwardCache()
  stubFeeds()
})
afterEach(() => vi.unstubAllGlobals())

describe('the tick is a fraction of the asset s own spot', () => {
  it('scales with spot instead of being an absolute step', () => {
    // The same 1% declaration, four orders of magnitude apart.
    expect(niceStrikeStep(0.19, 0.01)).toBeCloseTo(0.002, 10)
    expect(niceStrikeStep(81_000, 0.01)).toBe(1000)
  })

  it('a book declaring a finer tick rounds its rungs finer', () => {
    const spot = 81_000
    const coarse = roundStrike(spot * 1.02, spot, 0.01)
    const fine = roundStrike(spot * 1.02, spot, 0.002)
    expect(coarse).toBe(83_000)
    expect(fine).toBe(82_600)
    expect(fine).not.toBe(coarse)
  })
})

describe('quoteLadder draws the asset s own rungs', () => {
  it('a book with three rungs gets three, at its own multiples', async () => {
    const asset = book('ZZZ', {
      callOtm: [1.03, 1.09, 1.3],
      putOtm: [0.97, 0.91, 0.7],
      tickFraction: 0.005,
    })
    const spot = 1_000

    const calls = await quoteLadder('call', spot, 7, 0, asset)
    expect(calls.rungs).toHaveLength(3)
    expect(calls.rungs.map((r) => r.strike)).toEqual(
      asset.strike.callOtm.map((m) => roundStrike(spot * m, spot, asset.strike.tickFraction)),
    )

    const puts = await quoteLadder('put', spot, 7, 0, asset)
    expect(puts.rungs.map((r) => r.strike)).toEqual(
      asset.strike.putOtm.map((m) => roundStrike(spot * m, spot, asset.strike.tickFraction)),
    )
  })

  it('two books at one spot draw different ladders', async () => {
    const wide = book('WIDE', {
      callOtm: [1.1, 1.4],
      putOtm: [0.9, 0.6],
      tickFraction: 0.01,
    })
    const tight = book('TGHT', {
      callOtm: [1.01, 1.02],
      putOtm: [0.99, 0.98],
      tickFraction: 0.001,
    })
    const spot = 1_000

    const a = await quoteLadder('call', spot, 7, 0, wide)
    const b = await quoteLadder('call', spot, 7, 0, tight)
    expect(a.rungs.map((r) => r.strike)).not.toEqual(b.rungs.map((r) => r.strike))
    // Both were priced off the same σ and forward, so the ladder is the only
    // thing that moved: the wider book's nearest rung is further from the money.
    expect(a.rungs[0].strike).toBeGreaterThan(b.rungs[0].strike)
  })

  it('still draws the two real books at their declared rungs', async () => {
    for (const asset of [XLM, BTC]) {
      const spot = asset.symbol === 'BTC' ? 81_000 : 0.19
      const { rungs } = await quoteLadder('call', spot, 7, 0, asset)
      expect(rungs.map((r) => r.strike)).toEqual(
        strikeRungs('call', asset.strike).map((m) =>
          roundStrike(spot * m, spot, asset.strike.tickFraction),
        ),
      )
    }
  })
})

describe('a quote is normalized against its own book s nearest rung', () => {
  // This is the part that pays money rather than draws a screen. quoteOption
  // pins the nearest rung to the APR ceiling and scales every other strike by
  // the same factor. Normalized against another book's nearest rung, the same
  // strike scales by the wrong factor — so the premium the vault pays would not
  // be the premium any screen showed.
  //
  // Rich vol and a long tenor on purpose: normalization only bites when the
  // reference rung prices above the ceiling, which is exactly when the two
  // books would disagree about what a strike is worth.
  const base = {
    side: 'call' as const,
    spot: 1_000,
    daysToExpiry: 21,
    sigmaRealized: 1.6,
  }

  it('the nearest rung is the maximum its own book pays', () => {
    for (const strike of [
      { callOtm: [1.02, 1.1, 1.35], putOtm: [0.98, 0.9, 0.65], tickFraction: 0.01 },
      { callOtm: [1.15, 1.4], putOtm: [0.85, 0.6], tickFraction: 0.01 },
    ] as StrikeParams[]) {
      const aprs = strike.callOtm.map(
        (m) =>
          quoteOption({
            ...base,
            strike: roundStrike(base.spot * m, base.spot, strike.tickFraction),
            strikes: strike,
          }).apr,
      )
      for (let i = 1; i < aprs.length; i++) {
        expect(aprs[i]).toBeLessThan(aprs[i - 1])
      }
    }
  })

  it('the same strike pays differently under two ladders', () => {
    const near: StrikeParams = { callOtm: [1.02, 1.2], putOtm: [0.98, 0.8], tickFraction: 0.01 }
    const far: StrikeParams = { callOtm: [1.2, 1.4], putOtm: [0.8, 0.6], tickFraction: 0.01 }
    const strike = roundStrike(base.spot * 1.2, base.spot, 0.01)

    const underNear = quoteOption({ ...base, strike, strikes: near })
    const underFar = quoteOption({ ...base, strike, strikes: far })

    // One strike, one σ, one forward, one tenor. The only thing that differs is
    // which rung the book calls nearest: under `near` this strike is the far
    // end of the ladder and scales down from a richer reference, under `far` it
    // is the reference itself. Priced against the wrong book's ladder, the
    // vault pays this difference on every position.
    expect(underFar.apr).toBeGreaterThan(underNear.apr)
    expect(underFar.fairPremium).toBeCloseTo(underNear.fairPremium, 12)
  })

  it('holds a strike inside the book s nearest rung at the ceiling', () => {
    // The security clamp, now per book. A client submits the strike, so it can
    // sit nearer the money than any rung the book draws — where its raw APR
    // scales above the reference. Whichever ladder it is quoted under, it is
    // held at that ladder's ceiling rather than paying above the screen.
    const inside = roundStrike(base.spot * 1.02, base.spot, 0.01)
    const further: StrikeParams = { callOtm: [1.3], putOtm: [0.7], tickFraction: 0.01 }

    const offLadder = quoteOption({ ...base, strike: inside, strikes: further })
    const onLadder = quoteOption({ ...base, strike: inside, strikes: XLM.strike })

    expect(offLadder.aprCapped).toBe(true)
    expect(onLadder.aprCapped).toBe(true)
    expect(offLadder.apr).toBeLessThanOrEqual(onLadder.apr + 1e-9)
  })

  it('an omitted ladder is XLM s, the default the rest of the engine takes', () => {
    const strike = roundStrike(base.spot * 1.06, base.spot, XLM.strike.tickFraction)
    const implicit = quoteOption({ ...base, strike })
    const explicit = quoteOption({ ...base, strike, strikes: XLM.strike })
    expect(implicit.apr).toBe(explicit.apr)
    expect(implicit.userPremium).toBe(explicit.userPremium)
  })

  it('leaves the Greeks alone, which is why portfolio can omit it', () => {
    const strike = roundStrike(base.spot * 1.1, base.spot, 0.01)
    const a = quoteOption({
      ...base,
      strike,
      strikes: { callOtm: [1.02], putOtm: [0.98], tickFraction: 0.01 },
    })
    const b = quoteOption({
      ...base,
      strike,
      strikes: { callOtm: [1.3], putOtm: [0.7], tickFraction: 0.01 },
    })
    expect(a.delta).toBeCloseTo(b.delta, 12)
    expect(a.vega).toBeCloseTo(b.vega, 12)
    expect(a.sigmaStrike).toBeCloseTo(b.sigmaStrike, 12)
  })
})
