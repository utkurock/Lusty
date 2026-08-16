import { describe, it, expect } from 'vitest'
import { pricingDaysFor } from '../quote-inputs'
import { upcomingExpiryDates, MIN_DAYS_TO_EXPIRY } from '../expiries'

// The tenor a premium is priced against has to be a function of the expiry and
// nothing else. When the browser derived it from its own clock and the
// co-signature from the server's, the two could land on different integers for
// the same position — and a different tenor is a different premium, which the
// quoter then refused as "above the quote".

describe('pricingDaysFor', () => {
  it('rounds up, so a partial day is never priced as a shorter lock', () => {
    const now = new Date('2026-06-08T12:00:00Z').getTime()
    const expiry = new Date('2026-06-12T08:00:00Z').getTime() // 3.83 days out
    expect(pricingDaysFor(expiry, now)).toBe(4)
  })

  it('never prices below the minimum tenor the schedule writes', () => {
    const now = new Date('2026-06-08T12:00:00Z').getTime()
    const expiry = now + 6 * 3600_000 // six hours out
    expect(pricingDaysFor(expiry, now)).toBe(MIN_DAYS_TO_EXPIRY)
  })

  it('is a function of the expiry alone — same expiry, same days', () => {
    // The UI's clock and the server's, a plausible skew apart, inside the same
    // day. Both must price the same tenor.
    const expiry = new Date('2026-06-19T08:00:00Z').getTime()
    const browser = new Date('2026-06-15T09:59:58Z').getTime()
    const server = new Date('2026-06-15T10:00:03Z').getTime()
    expect(pricingDaysFor(expiry, browser)).toBe(pricingDaysFor(expiry, server))
  })

  it('gives every open expiry a distinct, increasing tenor', () => {
    const from = new Date('2026-06-08T12:00:00Z')
    const days = upcomingExpiryDates(from).map((d) =>
      pricingDaysFor(d.getTime(), from.getTime()),
    )
    for (let i = 1; i < days.length; i++) {
      expect(days[i]).toBe(days[i - 1] + 7)
    }
  })
})
