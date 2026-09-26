import { describe, it, expect, beforeEach } from 'vitest'
import { XLM, BTC } from '../assets'
import { reserve, resetRoutingBudget } from '../routing/budget'
import {
  realisedBps,
  record,
  resetRoutingJournal,
  summarise,
} from '../routing/journal'
import { checkRouting } from '../monitor/checks'

const NOW = 1_700_000_000_000
const HOUR = 3_600_000

beforeEach(() => {
  resetRoutingBudget()
  resetRoutingJournal()
})

function fill(over: Partial<{ book: string; quoted: number; spent: number; at: number }> = {}) {
  record({
    kind: 'filled',
    route: 'usdc->lusd',
    book: over.book ?? 'XLM',
    destAmount: 100,
    quoted: over.quoted ?? 100,
    spent: over.spent ?? 100,
    at: over.at ?? NOW,
  })
}

function refused(code: any, over: Partial<{ book: string; at: number }> = {}) {
  record({
    kind: 'refused',
    route: 'usdc->lusd',
    book: over.book ?? 'XLM',
    code,
    reason: String(code),
    at: over.at ?? NOW,
  })
}

describe('realised slippage is measured against the quote', () => {
  it('is positive when a fill cost more than it was quoted', () => {
    expect(realisedBps({ quoted: 100, spent: 100.5 })).toBeCloseTo(50, 7)
  })

  it('is negative on a fill better than the quote, rather than clamped to zero', () => {
    // A book that keeps filling BETTER than quoted is telling you the quote is
    // stale too, which is worth being able to see.
    expect(realisedBps({ quoted: 100, spent: 99 })).toBeCloseTo(-100, 7)
  })

  it('answers zero rather than infinity for a quote of nothing', () => {
    expect(realisedBps({ quoted: 0, spent: 5 })).toBe(0)
  })
})

describe('the journal summarises one book at a time', () => {
  it('keeps one book s routes out of another s', () => {
    fill({ book: 'XLM', quoted: 100, spent: 100.1 })
    refused('no_liquidity', { book: 'BTC' })

    expect(summarise('XLM', HOUR, NOW)).toMatchObject({ filled: 1, refused: 0 })
    expect(summarise('BTC', HOUR, NOW)).toMatchObject({ filled: 0, refused: 1 })
  })

  it('forgets what fell out of the window', () => {
    fill({ at: NOW - HOUR - 1 })
    fill({ at: NOW - 1000 })
    expect(summarise('XLM', HOUR, NOW).filled).toBe(1)
  })

  it('reports the worst fill, not just the average', () => {
    fill({ quoted: 100, spent: 100.05 })
    fill({ quoted: 100, spent: 100.45 })
    const s = summarise('XLM', HOUR, NOW)
    expect(s.worstBps).toBeCloseTo(45, 6)
    expect(s.meanBps).toBeCloseTo(25, 6)
  })

  it('counts refusals by kind, so the cause is legible', () => {
    refused('no_liquidity')
    refused('no_liquidity')
    refused('path_not_allowed')
    const s = summarise('XLM', HOUR, NOW)
    // "No liquidity every time" is a market problem and "path not allowed every
    // time" is an allowlist that has fallen behind one. Different people fix
    // them, so the mix is the point rather than the total.
    expect(s.refusals[0]).toEqual({ code: 'no_liquidity', count: 2 })
    expect(s.refusals[1]).toEqual({ code: 'path_not_allowed', count: 1 })
  })

  it('says nothing about slippage when nothing filled', () => {
    refused('no_liquidity')
    const s = summarise('XLM', HOUR, NOW)
    // Null, not zero. Zero slippage is a claim; no fills is an absence.
    expect(s.worstBps).toBeNull()
    expect(s.meanBps).toBeNull()
  })
})

describe('the monitor watches each book s routes', () => {
  it('is quiet when nothing has happened', () => {
    expect(checkRouting(XLM, NOW)).toBeNull()
  })

  it('pages when a book s routing capacity is full', () => {
    reserve(XLM, XLM.routedCapUsd, NOW)
    const alert = checkRouting(XLM, NOW)
    expect(alert?.severity).toBe('critical')
    expect(alert?.title).toMatch(/XLM.*routing capacity full/)
  })

  it('warns before it is full', () => {
    reserve(XLM, XLM.routedCapUsd * 0.95, NOW)
    expect(checkRouting(XLM, NOW)?.severity).toBe('warning')
  })

  it('warns on fills that keep landing at the slippage ceiling', () => {
    // The case nothing else catches: every one of these SUCCEEDED and every one
    // was inside the allowance, so no refusal was ever recorded. The only
    // evidence that the book has no depth is what the fills cost.
    fill({ quoted: 100, spent: 100.48 })
    const alert = checkRouting(XLM, NOW)
    expect(alert?.severity).toBe('warning')
    expect(alert?.title).toMatch(/slippage ceiling/)
  })

  it('warns when most attempts are being refused, and says with what', () => {
    for (let i = 0; i < 3; i++) refused('no_liquidity')
    fill()
    const alert = checkRouting(XLM, NOW)
    expect(alert?.severity).toBe('warning')
    expect(alert?.message).toMatch(/no_liquidity×3/)
  })

  it('does not warn on one refusal, which is a market rather than a fault', () => {
    refused('no_liquidity')
    expect(checkRouting(XLM, NOW)).toBeNull()
  })

  it('alerts about one book without alerting about the other', () => {
    reserve(BTC, BTC.routedCapUsd, NOW)
    expect(checkRouting(BTC, NOW)?.severity).toBe('critical')
    expect(checkRouting(XLM, NOW)).toBeNull()
  })

  it('names the book in every alert it raises', () => {
    reserve(BTC, BTC.routedCapUsd, NOW)
    const alert = checkRouting(BTC, NOW)!
    expect(alert.title).toContain('BTC')
    expect(alert.fields?.find((f) => f.label === 'underlying')?.value).toBe('BTC')
  })
})
