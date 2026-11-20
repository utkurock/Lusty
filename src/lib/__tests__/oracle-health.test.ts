import { describe, expect, it } from 'vitest'
import { expiriesAtRisk, oracleHealthAlert, type OracleReading } from '../monitor/oracle-health'
import { ORACLE_HISTORY_SECS } from '../oracle-window'
import { REFLECTOR_MAX_STALENESS_SECS } from '../reflector'
import { BTC, XLM } from '../assets'

// The feed's own health.
// ======================
// Every test starts from a healthy reading — fresh record, no holes, on the
// exchange's price — and moves one thing. The clean case has to be clean or a
// monitor that alerts on every run is a monitor nobody reads.

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0)
const RESOLUTION = 300

const healthy = (): OracleReading => ({
  last: { price: 100_000, timestamp: Math.floor(NOW / 1000) - 60 },
  resolutionSecs: RESOLUTION,
  probed: [],
  missing: [],
  exchange: 100_000,
})

const alertOf = (mutate: (r: OracleReading) => void = () => {}, asset = BTC) => {
  const r = healthy()
  mutate(r)
  return oracleHealthAlert(asset, r, NOW)
}

describe('expiriesAtRisk', () => {
  it('names only expiries that have passed and are still inside the oracle window', () => {
    const at = expiriesAtRisk(BTC, NOW)
    for (const d of at) {
      expect(d.getTime()).toBeLessThanOrEqual(NOW)
      expect(d.getTime()).toBeGreaterThan(NOW - ORACLE_HISTORY_SECS * 1000)
    }
  })

  it("walks the book's own grid, so an expiry one tenor back is reached by a wide window", () => {
    const tenorMs = XLM.expiry.tenorDays * 24 * 60 * 60 * 1000
    const wide = expiriesAtRisk(XLM, NOW, (2 * tenorMs) / 1000)
    expect(wide.length).toBeGreaterThan(0)
    // Grid points, in order, each a whole tenor apart.
    for (let i = 1; i < wide.length; i++) {
      expect(wide[i].getTime() - wide[i - 1].getTime()).toBe(tenorMs)
    }
    for (const d of wide) expect(d.getUTCHours()).toBe(8)
  })

  it('names nothing when the window is shorter than the gap to the last expiry', () => {
    expect(expiriesAtRisk(BTC, NOW, 1)).toEqual([])
  })
})

describe('oracleHealthAlert', () => {
  it('says nothing about a feed that is fresh, complete and on the market', () => {
    expect(alertOf()).toBeNull()
  })

  it('pages on a period missing at an expiry that has already passed', () => {
    const missed = new Date(NOW - 3_600_000)
    const a = alertOf((r) => {
      r.probed = [missed]
      r.missing = [missed]
    })
    expect(a?.severity).toBe('critical')
    expect(a?.title).toBe('BTC: oracle has no price for an expiry that has passed')
    expect(a?.message).toContain(missed.toISOString())
    expect(a?.message).toContain('record_price')
  })

  // A hole is the only failure here that gets worse by waiting, so it outranks
  // a reading that is merely stale or off the market.
  it('reports the hole first when the feed is also stale and off the band', () => {
    const missed = new Date(NOW - 3_600_000)
    const a = alertOf((r) => {
      r.probed = [missed]
      r.missing = [missed]
      r.last = { price: 50_000, timestamp: Math.floor(NOW / 1000) - 10_000 }
    })
    expect(a?.title).toContain('no price for an expiry')
  })

  it('pages when the feed has no record at all', () => {
    const a = alertOf((r) => {
      r.last = null
    })
    expect(a?.severity).toBe('critical')
    expect(a?.title).toBe('BTC: oracle has no price at all')
  })

  it('warns past two resolutions and pages past the bound the contract itself accepts', () => {
    const aged = (secs: number) => (r: OracleReading) => {
      r.last = { price: 100_000, timestamp: Math.floor(NOW / 1000) - secs }
    }
    expect(alertOf(aged(2 * RESOLUTION))).toBeNull()
    const late = alertOf(aged(2 * RESOLUTION + 1))
    expect(late?.severity).toBe('warning')
    expect(late?.title).toBe('BTC: oracle is behind its own schedule')

    const stopped = alertOf(aged(REFLECTOR_MAX_STALENESS_SECS + 1))
    expect(stopped?.severity).toBe('critical')
    expect(stopped?.title).toBe('BTC: oracle has stopped publishing')
    expect(stopped?.message).toContain(String(REFLECTOR_MAX_STALENESS_SECS))
  })

  it('warns at the band against the exchange and pages at twice it', () => {
    // 200 bps default: 2% of 100,000 is 2,000.
    expect(alertOf((r) => {
      r.exchange = 101_900
    })).toBeNull()

    const wide = alertOf((r) => {
      r.exchange = 102_100
    })
    expect(wide?.severity).toBe('warning')
    expect(wide?.title).toBe('BTC: oracle disagrees with the exchange')

    const far = alertOf((r) => {
      r.exchange = 110_000
    })
    expect(far?.severity).toBe('critical')
    expect(far?.message).toContain('beyond twice the band')
  })

  it('measures the gap in both directions', () => {
    const under = alertOf((r) => {
      r.exchange = 95_000
    })
    expect(under?.title).toContain('disagrees with the exchange')
    expect(under?.fields?.find((f) => f.label === 'gap_bps')?.value).toBe('526.3')
  })

  // Without the exchange the feed is still judged on its own timestamps. A
  // second opinion that is unavailable must not silence the first.
  it('still judges staleness when the exchange cannot be read', () => {
    expect(alertOf((r) => {
      r.exchange = null
    })).toBeNull()
    const late = alertOf((r) => {
      r.exchange = null
      r.last = { price: 100_000, timestamp: Math.floor(NOW / 1000) - 10_000 }
    })
    expect(late?.severity).toBe('critical')
    expect(late?.fields?.find((f) => f.label === 'gap_bps')?.value).toBe('—')
  })

  it('names the book and its feed in every alert', () => {
    const a = alertOf((r) => {
      r.last = null
    }, XLM)
    expect(a?.title.startsWith('XLM:')).toBe(true)
    expect(a?.message).toContain(XLM.feedSymbol)
    expect(a?.fields).toEqual(
      expect.arrayContaining([
        { label: 'underlying', value: 'XLM' },
        { label: 'feed', value: XLM.feedSymbol },
      ]),
    )
  })
})
