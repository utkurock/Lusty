// What the routes actually did.
// ============================
// A bound nobody watches is a bound nobody knows held. The allowlist, the
// slippage allowance and the in-flight cap all refuse things; this records
// whether they had to, and at what cost when they did not.
//
// Two numbers are worth more than the rest. REALISED slippage — what a fill
// actually cost against what it was quoted — because the allowance is a
// ceiling and a book that keeps filling at the ceiling is a book with no depth
// in it. And the REFUSAL mix, because "no liquidity" every time is a market
// problem, "path not allowed" every time is an allowlist that has fallen behind
// the market, and the two need different people.
//
// A ring buffer in memory, per process, like the rate limiter and the routing
// budget. It is an observation, not an accounting record: nothing is decided
// from it, so losing it on a deploy costs a window of visibility rather than
// correctness. Anything that has to survive belongs in the transactions ledger.

import type { RouteRefusalCode } from './quote'

/** Enough to see a pattern, small enough to never be a memory question. */
const CAPACITY = 200

export type RouteOutcome =
  | {
      kind: 'filled'
      route: string
      book: string
      /** Delivered, in the receive asset. */
      destAmount: number
      /** Quoted cost, in the send asset. */
      quoted: number
      /** What it actually cost. */
      spent: number
      at: number
    }
  | {
      kind: 'refused'
      route: string
      book: string
      /** `not_filled`: prepared, then abandoned or failed on the ledger. */
      code: RouteRefusalCode | 'routing_cap' | 'not_filled'
      reason: string
      at: number
    }

const entries: RouteOutcome[] = []

export function record(outcome: RouteOutcome): void {
  entries.push(outcome)
  if (entries.length > CAPACITY) entries.splice(0, entries.length - CAPACITY)
}

/** Everything recorded in the last `windowMs`, newest last. */
export function recent(windowMs: number, now: number = Date.now()): RouteOutcome[] {
  const from = now - windowMs
  return entries.filter((e) => e.at >= from)
}

/**
 * Realised slippage on one fill, in basis points of the quote.
 *
 * Positive means it cost more than quoted, which is the direction that matters.
 * Negative is a fill better than the quote and is not a problem, but it is
 * still recorded rather than clamped — a book that keeps filling *better* than
 * quoted is telling you the quote is stale too.
 */
export function realisedBps(fill: { quoted: number; spent: number }): number {
  if (!(fill.quoted > 0)) return 0
  return ((fill.spent - fill.quoted) / fill.quoted) * 10_000
}

export interface RoutingSummary {
  book: string
  filled: number
  refused: number
  /** Worst realised slippage in the window, in bps. Null when nothing filled. */
  worstBps: number | null
  /** Mean realised slippage in the window, in bps. Null when nothing filled. */
  meanBps: number | null
  /** How many refusals of each kind, most common first. */
  refusals: Array<{ code: string; count: number }>
}

export function summarise(
  book: string,
  windowMs: number,
  now: number = Date.now(),
): RoutingSummary {
  const mine = recent(windowMs, now).filter((e) => e.book === book)
  const fills = mine.filter((e): e is Extract<RouteOutcome, { kind: 'filled' }> =>
    e.kind === 'filled',
  )
  const bps = fills.map(realisedBps)

  const counts = new Map<string, number>()
  for (const e of mine) {
    if (e.kind === 'refused') counts.set(e.code, (counts.get(e.code) ?? 0) + 1)
  }

  return {
    book,
    filled: fills.length,
    refused: mine.length - fills.length,
    worstBps: bps.length ? Math.max(...bps) : null,
    meanBps: bps.length ? bps.reduce((a, b) => a + b, 0) / bps.length : null,
    refusals: [...counts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count),
  }
}

/** Tests only. */
export function resetRoutingJournal(): void {
  entries.length = 0
}
