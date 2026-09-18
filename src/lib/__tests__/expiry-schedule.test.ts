import { describe, it, expect, vi } from 'vitest'
import { StrKey } from '@stellar/stellar-sdk'
import { declare, type AssetDeclaration } from '../assets/schema'
import { XLM, BTC, type ExpiryParams } from '../assets'
import {
  getExpiryOptions,
  maxOpenExpiryDays,
  minDaysToExpiry,
  openExpiryCount,
  upcomingExpiryDates,
} from '../expiries'
import { pricingDaysFor } from '../quote-inputs'

// M2-04. The schedule is the asset's, not the module's.
//
// Three numbers were global: how many expiries are open, how close to
// settlement the book still writes, and how far apart the expiries sit. The
// first is not cosmetic — it divides the monthly capacity into the per-expiry
// bucket that M2-05 reconciles against the instance's own `max_expiry_*`, so a
// book dividing by another book's count is checked against a bound its own
// contract does not enforce.

const VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x41))
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 0x42))
const CASH = StrKey.encodeContract(Buffer.alloc(32, 0x43))

/** A declared book whose schedule nothing else in the repo uses. */
function book(symbol: string, expiry: ExpiryParams) {
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
    strike: { callOtm: [1.02, 1.1], putOtm: [0.98, 0.9], tickFraction: 0.01 },
    expiry,
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

// A Wednesday, so the minimum tenor and the Friday anchor are both in play.
const NOW = new Date('2026-09-16T12:00:00.000Z')
const DAY = 86_400_000

describe('a book keeps its own number of expiries open', () => {
  it('opens as many as it declares', () => {
    for (const openExpiries of [1, 2, 3, 5]) {
      const a = book('ZZZ', { openExpiries, minDaysToExpiry: 2, tenorDays: 7 })
      expect(upcomingExpiryDates(NOW, a.expiry)).toHaveLength(openExpiries)
      expect(openExpiryCount(a.expiry)).toBe(openExpiries)
    }
  })

  it('spaces them by its own tenor', () => {
    const fortnightly = book('FTN', { openExpiries: 3, minDaysToExpiry: 2, tenorDays: 14 })
    const dates = upcomingExpiryDates(NOW, fortnightly.expiry)
    expect((dates[1].getTime() - dates[0].getTime()) / DAY).toBe(14)
    expect((dates[2].getTime() - dates[1].getTime()) / DAY).toBe(14)

    const weekly = upcomingExpiryDates(NOW, XLM.expiry)
    expect((weekly[1].getTime() - weekly[0].getTime()) / DAY).toBe(7)
  })

  it('writes no closer to settlement than its own minimum tenor', () => {
    for (const minDays of [2, 5, 9]) {
      const a = book('ZZZ', { openExpiries: 3, minDaysToExpiry: minDays, tenorDays: 7 })
      const first = upcomingExpiryDates(NOW, a.expiry)[0]
      expect((first.getTime() - NOW.getTime()) / DAY).toBeGreaterThanOrEqual(minDays)
      expect(minDaysToExpiry(a.expiry)).toBe(minDays)
    }
  })

  // Regression, found by this commit and older than it. The anchor is snapped
  // to 08:00 UTC after the cutoff is applied, so a cutoff landing on a Friday
  // afternoon used to snap backwards to that morning — inside the minimum the
  // book declares. `/api/vault/authorize` refuses anything under that minimum,
  // so the screen offered a front expiry the money path then declined with a
  // 409. For XLM's two-day minimum that was every Wednesday afternoon UTC.
  it('never anchors behind its own cutoff when the hour is pinned', () => {
    for (const hour of [9, 12, 18, 23]) {
      const wednesday = new Date(`2026-09-16T${String(hour).padStart(2, '0')}:00:00.000Z`)
      for (const asset of [XLM, BTC]) {
        const first = upcomingExpiryDates(wednesday, asset.expiry)[0]
        const days = (first.getTime() - wednesday.getTime()) / DAY
        expect(days).toBeGreaterThanOrEqual(asset.expiry.minDaysToExpiry)
      }
    }
  })

  it('every expiry lands at 08:00 UTC, whatever the schedule', () => {
    const a = book('ZZZ', { openExpiries: 4, minDaysToExpiry: 6, tenorDays: 14 })
    for (const d of upcomingExpiryDates(NOW, a.expiry)) {
      expect(d.getUTCHours()).toBe(8)
      expect(d.getUTCMinutes()).toBe(0)
      expect(d.getUTCSeconds()).toBe(0)
    }
  })
})

describe('the time reference follows the book s own schedule', () => {
  // The pricing engine scales its whole ladder against the farthest open
  // expiry: that tenor quotes at the APR ceiling and nearer ones fall below it.
  // Read off another book's schedule, a long book pays the ceiling too early
  // and a short one strands its own farthest expiry under the cap.
  it('a longer schedule reaches further out', () => {
    const short = book('SHRT', { openExpiries: 2, minDaysToExpiry: 2, tenorDays: 7 })
    const long = book('LONG', { openExpiries: 4, minDaysToExpiry: 2, tenorDays: 14 })
    expect(maxOpenExpiryDays(NOW, long.expiry)).toBeGreaterThan(
      maxOpenExpiryDays(NOW, short.expiry),
    )
  })

  it('is never below the book s minimum tenor', () => {
    const a = book('ZZZ', { openExpiries: 1, minDaysToExpiry: 9, tenorDays: 7 })
    expect(maxOpenExpiryDays(NOW, a.expiry)).toBeGreaterThanOrEqual(9)
  })
})

describe('the expiry options a screen draws are the book s own', () => {
  it('offers its own count, and dates its windows by its own tenor', () => {
    const a = book('FTN', { openExpiries: 2, minDaysToExpiry: 3, tenorDays: 14 })
    const options = getExpiryOptions('call', undefined, a.expiry)
    expect(options).toHaveLength(2)
    expect(options.map((o) => o.totalEpochDays)).toEqual([14, 28])
    for (const o of options) {
      expect(o.daysToExpiry).toBeGreaterThanOrEqual(3)
    }
  })

  it('prices an expiry no shorter than its own minimum tenor', () => {
    const a = book('ZZZ', { openExpiries: 3, minDaysToExpiry: 6, tenorDays: 7 })
    const tomorrow = NOW.getTime() + DAY
    expect(pricingDaysFor(tomorrow, NOW.getTime(), a)).toBe(6)
    // XLM's own floor is lower, and the same expiry prices against that.
    expect(pricingDaysFor(tomorrow, NOW.getTime(), XLM)).toBe(XLM.expiry.minDaysToExpiry)
  })
})

describe('the capacity divisor is the book s own count', () => {
  it('splits each book s monthly capacity across its own expiries', async () => {
    vi.resetModules()
    vi.doMock('@/lib/db', () => ({
      ensureSchema: async () => {},
      getPool: () => ({ query: async () => ({ rows: [] }) }),
    }))
    const state = await import('../vault-state')

    for (const asset of [XLM, BTC]) {
      expect(state.epochsPerMonth(asset)).toBe(asset.expiry.openExpiries)
      expect(state.callEpochCap(asset)).toBe(
        asset.callMonthlyCap / asset.expiry.openExpiries,
      )
      expect(state.putEpochCap(asset)).toBe(
        asset.putMonthlyCapUsd / asset.expiry.openExpiries,
      )
    }

    // A book that opened twice as many expiries would write half as much into
    // each one — which is the figure the contract's per-expiry cap bounds.
    const dense = book('DNSE', { openExpiries: 6, minDaysToExpiry: 2, tenorDays: 7 })
    expect(state.callEpochCap(dense)).toBe(dense.callMonthlyCap / 6)
    vi.doUnmock('@/lib/db')
  })
})

describe('the two real books are unmoved', () => {
  it('still open three weekly Fridays, two days out', () => {
    for (const asset of [XLM, BTC]) {
      expect(asset.expiry).toEqual({ openExpiries: 3, minDaysToExpiry: 2, tenorDays: 7 })
      const dates = upcomingExpiryDates(NOW, asset.expiry)
      expect(dates).toHaveLength(3)
      for (const d of dates) expect(d.getUTCDay()).toBe(5)
      expect((dates[2].getTime() - dates[0].getTime()) / DAY).toBe(14)
    }
  })
})
