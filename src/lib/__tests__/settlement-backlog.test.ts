import { describe, expect, it } from 'vitest'
import { backlogAlert, type Backlog } from '../monitor/settlement-backlog'
import { ORACLE_HISTORY_SECS, UNPRICED_RELEASE_SECS } from '../oracle-window'
import type { SettlementCandidate } from '../settlement'
import { XLM } from '../assets'

// What the backlog alarm says about a position past the oracle window.
// =====================================================================
// v5 settles it at a recorded price, or releases it as kept thirty days after
// expiry; only v4 locks it for good. The alarm used to say "locked permanently"
// about all three.

const NOW = new Date(Date.UTC(2026, 10, 22, 12, 0, 0))
const H = 3_600_000
const WINDOW = ORACLE_HISTORY_SECS * 1000

const candidate = (id: number, expiry: Date): SettlementCandidate => {
  const settleBy = new Date(expiry.getTime() + WINDOW)
  return {
    id,
    underlying: 'XLM',
    vault: XLM.contracts.vault,
    owner: 'G…',
    side: 'call',
    strike: 0.4,
    collateral: 100,
    expiry,
    settleBy,
    pastDeadline: NOW.getTime() > settleBy.getTime(),
  }
}

const OLD = new Date(NOW.getTime() - 3 * 24 * H) // past the window
const FRESH = new Date(NOW.getTime() - 2 * H) // inside it

const backlog = (cs: SettlementCandidate[], prices: Record<number, any>): Backlog => ({
  asset: XLM,
  candidates: cs,
  prices: new Map(Object.entries(prices).map(([k, v]) => [Number(k), v])),
})

describe('backlogAlert', () => {
  it('is silent when nothing is due', () => {
    expect(backlogAlert(backlog([], {}), NOW)).toBeNull()
  })

  it('describes a v5 position with no recorded price as released as kept, with the release date', () => {
    const a = backlogAlert(backlog([candidate(7, OLD)], { [OLD.getTime()]: 'unrecorded' }), NOW)!
    const release = new Date(OLD.getTime() + UNPRICED_RELEASE_SECS * 1000).toISOString().slice(0, 10)
    expect(a.severity).toBe('critical')
    expect(a.message).toContain('releases their collateral to the owner as kept')
    expect(a.message).toContain(release)
    expect(a.message).toContain('XLM#7')
    expect(a.message).not.toMatch(/permanently|for good/)
    expect(a.fields).toContainEqual({ label: 'first_release', value: release })
  })

  it('keeps "for good" for a v4 instance, which has neither a recorded price nor a release', () => {
    const a = backlogAlert(backlog([candidate(29, OLD)], { [OLD.getTime()]: 'unsupported' }), NOW)!
    expect(a.severity).toBe('critical')
    expect(a.message).toContain('v4 instance')
    expect(a.message).toContain('for good')
  })

  it('treats a recorded price past the window as a late sweep, not a missed one', () => {
    const a = backlogAlert(backlog([candidate(3, OLD)], { [OLD.getTime()]: 'recorded' }), NOW)!
    expect(a.severity).toBe('warning')
    expect(a.title).toContain('sweep is behind')
    expect(a.message).toContain('settle at their recorded price')
    expect(a.message).not.toMatch(/permanently|for good|missed/)
  })

  it('pages when it cannot read whether a price is recorded', () => {
    const a = backlogAlert(backlog([candidate(4, OLD)], {}), NOW)!
    expect(a.severity).toBe('critical')
    expect(a.message).toContain('could not be read')
  })

  it("counts down to the oracle window for a due position, and says what happens after it", () => {
    const a = backlogAlert(backlog([candidate(1, FRESH)], { [FRESH.getTime()]: 'unrecorded' }), NOW)!
    expect(a.severity).toBe('warning')
    expect(a.fields).toContainEqual({ label: 'hours_to_deadline', value: '22.0' })
    expect(a.message).toContain('released unassigned thirty days after expiry')
    expect(a.message).not.toMatch(/locked/)
  })

  it('drops the countdown once the expiry is recorded', () => {
    const a = backlogAlert(backlog([candidate(1, FRESH)], { [FRESH.getTime()]: 'recorded' }), NOW)!
    expect(a.severity).toBe('warning')
    expect(a.fields?.some((f) => f.label === 'hours_to_deadline')).toBe(false)
  })

  it('lets the worst class set the severity and still counts the others', () => {
    const a = backlogAlert(
      backlog([candidate(1, FRESH), candidate(2, OLD), candidate(3, OLD)], {
        [FRESH.getTime()]: 'unrecorded',
        [OLD.getTime()]: 'unrecorded',
      }),
      NOW,
    )!
    expect(a.severity).toBe('critical')
    expect(a.fields).toContainEqual({ label: 'due', value: '1' })
    expect(a.fields).toContainEqual({ label: 'past_window_unpriced', value: '2' })
  })
})
