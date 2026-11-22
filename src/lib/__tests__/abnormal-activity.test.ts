import { describe, expect, it } from 'vitest'
import {
  activityAlert,
  premiumBps,
  type ActivityReading,
  type Thresholds,
} from '../monitor/abnormal-activity'
import type { VaultEvent } from '../contract-events'
import type { VaultLimits } from '../vault-contract'
import { XLM } from '../assets'

// Abnormal position activity.
// ===========================
// Each test starts from a quiet book — a few ordinary opens, no dominant
// holder — and moves one thing. Nothing here is a breach: every limit is the
// contract's to enforce. The quiet case has to stay quiet.

const T: Thresholds = {
  burstOpens: 5,
  atCapPct: 95,
  atCapOpens: 2,
  nearCeilingPct: 90,
  walletSharePct: 40,
  minDepthPositions: 3,
}

const LIMITS: VaultLimits = {
  maxPositionCall: 1_000,
  maxPositionPut: 500,
  maxExpiryCall: 10_000,
  maxExpiryPut: 5_000,
  maxOpenCall: 20_000,
  maxOpenPut: 10_000,
  maxPremiumBps: 500,
}

const SPOT = 0.4
let nextId = 0
const open = (o: Partial<VaultEvent> = {}): VaultEvent => ({
  kind: 'deposit',
  id: String(nextId++),
  ledger: 1,
  at: '2026-11-22T12:00:00Z',
  contractId: XLM.contracts.vault,
  owner: `G${'A'.repeat(54)}${nextId}`,
  side: 'call',
  amount: 100,
  // 1% of 100 XLM at 0.40: 0.4 cash, 100 bps.
  premiumCash: 0.4,
  ...o,
})

const quiet = (): ActivityReading => ({
  opens: [open(), open({ side: 'put', amount: 50, premiumCash: 0.5 })],
  holdings: [
    { side: 'call', owner: 'GOWNER1', amount: 1_000, total: 5_000 },
    { side: 'put', owner: 'GOWNER2', amount: 300, total: 2_000 },
  ],
  limits: LIMITS,
  spot: SPOT,
})

const alertOf = (mutate: (r: ActivityReading) => void = () => {}) => {
  const r = quiet()
  mutate(r)
  return activityAlert(XLM, r, T, 3_600_000)
}

describe('premiumBps', () => {
  it("measures a put's premium against its cash collateral", () => {
    expect(premiumBps(open({ side: 'put', amount: 100, premiumCash: 5 }), null)).toBeCloseTo(500)
  })
  it("values a call's collateral at spot, as the contract does", () => {
    expect(premiumBps(open({ amount: 100, premiumCash: 2 }), SPOT)).toBeCloseTo(500)
  })
  it('cannot measure a call without a spot', () => {
    expect(premiumBps(open(), null)).toBeNull()
  })
})

describe('activityAlert', () => {
  it('is silent on a quiet book', () => {
    expect(alertOf()).toBeNull()
  })

  it('reports a burst of opens, with how many wallets made it', () => {
    const a = alertOf((r) => {
      r.opens = Array.from({ length: 5 }, () => open({ owner: 'GSAME' }))
    })!
    expect(a.severity).toBe('warning')
    expect(a.title).toBe('XLM: abnormal position activity')
    expect(a.message).toContain('5 positions opened in the last 60 minutes from 1 wallet(s)')
  })

  it('stays quiet one open short of a burst', () => {
    expect(alertOf((r) => (r.opens = Array.from({ length: 4 }, () => open())))).toBeNull()
  })

  it('reports several positions at the cap, measured against their own leg', () => {
    const a = alertOf((r) => {
      r.opens.push(open({ amount: 1_000 }), open({ side: 'put', amount: 480 }))
    })!
    expect(a.fields).toContainEqual({ label: 'at_cap', value: '2' })
  })

  it('does not count one at-the-cap position as a pattern', () => {
    expect(alertOf((r) => r.opens.push(open({ amount: 1_000 })))).toBeNull()
  })

  it('reports a single premium near the ceiling, naming the position', () => {
    // 460 bps of a 500 bps ceiling: 1.84 cash on 100 XLM at 0.40.
    const a = alertOf((r) => r.opens.push(open({ id: '42', premiumCash: 1.84 })))!
    expect(a.message).toContain('XLM#42 460 bps')
    expect(a.fields).toContainEqual({ label: 'near_ceiling', value: '1' })
  })

  it('still checks put premiums when the spot cannot be read', () => {
    const a = alertOf((r) => {
      r.spot = null
      r.opens.push(open({ side: 'put', amount: 100, premiumCash: 4.9 }))
    })!
    expect(a.fields).toContainEqual({ label: 'near_ceiling', value: '1' })
  })

  it('reports one wallet holding a large share of a deep enough leg', () => {
    const a = alertOf((r) => (r.holdings[0] = { side: 'call', owner: 'GBIGWALLETXYZ', amount: 2_500, total: 5_000 }))!
    expect(a.message).toContain('GBIG…TXYZ holds 50% of the call leg')
    expect(a.fields).toContainEqual({ label: 'call_top_wallet_pct', value: '50.0' })
  })

  it('ignores concentration in a book only a couple of positions deep', () => {
    // 2,500 total on a 1,000 cap is under three full positions.
    expect(
      alertOf((r) => (r.holdings[0] = { side: 'call', owner: 'GONLY', amount: 2_500, total: 2_500 })),
    ).toBeNull()
  })

  it('names every finding in one alert', () => {
    const a = alertOf((r) => {
      r.opens.push(open({ amount: 1_000 }), open({ amount: 1_000, premiumCash: 19 }))
      r.holdings[1] = { side: 'put', owner: 'GPUTWHALEABCD', amount: 1_600, total: 2_000 }
    })!
    expect(a.fields?.map((f) => f.label)).toEqual(
      expect.arrayContaining(['at_cap', 'near_ceiling', 'put_top_wallet_pct']),
    )
  })
})
