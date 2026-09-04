import { describe, it, expect } from 'vitest'
import { realizedApr } from '../apr'
import { closeOn, utcDay, type DatedClose } from '../price-history'

const day = 86_400_000
const OPEN = Date.UTC(2026, 7, 16) // 2026-08-16

// lib/pricing-server's definition, held to here so the dashboard and the quote
// engine cannot drift into publishing two different rates for one position:
//
//   capital = spot for a call, the escrowed cash for a put
//   APR     = premium / capital · 365/days · 100
describe('realizedApr', () => {
  it('annualizes a call against the underlying at open', () => {
    // 10,000 XLM at $0.15 is $1,500 of capital; $26.4243 over 19 days.
    const apr = realizedApr({
      side: 'call',
      collateral: 10_000,
      premium: 26.4243,
      openedAt: OPEN,
      expiry: OPEN + 19 * day,
      spotAtOpen: 0.15,
    })
    expect(apr).toBeCloseTo((26.4243 / 1500) * (365 / 19) * 100, 6)
  })

  it('annualizes a put against its own cash, with no price at all', () => {
    const apr = realizedApr({
      side: 'put',
      collateral: 1_000,
      premium: 10,
      openedAt: OPEN,
      expiry: OPEN + 30 * day,
      spotAtOpen: null,
    })
    expect(apr).toBeCloseTo((10 / 1000) * (365 / 30) * 100, 6)
  })

  it('returns null for a call with no price, rather than a rate of zero', () => {
    // The distinction the old dashboard lost: unknown and zero are not the
    // same claim about what a writer earned.
    expect(
      realizedApr({
        side: 'call',
        collateral: 10_000,
        premium: 26.4243,
        openedAt: OPEN,
        expiry: OPEN + 19 * day,
        spotAtOpen: null,
      })
    ).toBeNull()
  })

  it('refuses a term of zero or less instead of dividing by it', () => {
    const base = {
      side: 'call' as const,
      collateral: 100,
      premium: 1,
      openedAt: OPEN,
      spotAtOpen: 0.15,
    }
    expect(realizedApr({ ...base, expiry: OPEN })).toBeNull()
    expect(realizedApr({ ...base, expiry: OPEN - day })).toBeNull()
  })

  it('refuses a position that paid nothing or escrowed nothing', () => {
    const base = {
      side: 'call' as const,
      openedAt: OPEN,
      expiry: OPEN + 10 * day,
      spotAtOpen: 0.15,
    }
    expect(realizedApr({ ...base, collateral: 0, premium: 1 })).toBeNull()
    expect(realizedApr({ ...base, collateral: 100, premium: 0 })).toBeNull()
  })
})

describe('closeOn', () => {
  const series: DatedClose[] = [
    { day: utcDay(OPEN - 2 * day), close: 0.14 },
    { day: utcDay(OPEN), close: 0.15 },
    { day: utcDay(OPEN + 3 * day), close: 0.16 },
  ]

  it('takes the close of the day the position opened', () => {
    expect(closeOn(series, OPEN + 3600_000)).toBe(0.15)
  })

  it('falls back to the last day before it', () => {
    expect(closeOn(series, OPEN + day)).toBe(0.15)
  })

  it('will not reach back more than a week for a price', () => {
    expect(closeOn(series, OPEN + 30 * day)).toBeNull()
  })

  it('has nothing to say about a day before the series starts', () => {
    expect(closeOn(series, OPEN - 30 * day)).toBeNull()
  })

  it('is null on an empty series, never zero', () => {
    expect(closeOn([], OPEN)).toBeNull()
  })
})
