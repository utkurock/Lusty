// How much of a book may sit in a route at once.
// =============================================
// Routing is the one thing a writer does here that is neither escrowed nor
// instant. A position's collateral is in the contract the moment the
// transaction lands; a swap is in flight from the moment it is built until the
// ledger closes it, and during that window the money is neither where it was
// nor where it is going.
//
// So it is bounded, and bounded the same way everything else on this desk is:
// a number declared per book (`routedCapUsd`), checked before the wallet is
// prompted rather than after the money has moved. A route is refused when
// taking it would put the book over.
//
// RESERVE, THEN RELEASE. The bound is meaningless if it is checked and then
// forgotten — two swaps built a second apart would each see an empty book. So a
// caller reserves before building and releases when the swap resolves, either
// way. A reservation nobody releases expires on its own, because a process that
// crashed mid-swap must not take a book's routing capacity down with it until
// the next deploy.
//
// WHAT THIS IS NOT. The ledger is in memory, per process — the same weakness
// the rate limiter has and for the same reason, and it is published as a known
// limitation rather than described as a guarantee. It bounds an honest client
// and a single-process deployment. What it is not is a defence against somebody
// deliberately opening a thousand swaps from a thousand connections; the
// durable bound behind that is the route's own per-swap notional ceiling, which
// no amount of concurrency widens.

import type { UnderlyingAsset } from '../assets'

/** A reservation lapses after this long even if nobody releases it. */
const RESERVATION_TTL_MS = 120_000

interface Reservation {
  book: string
  amount: number
  expiresAt: number
}

const held = new Map<string, Reservation>()
let counter = 0

function sweep(now: number): void {
  for (const [id, r] of held) {
    if (r.expiresAt <= now) held.delete(id)
  }
}

/** USD currently reserved against one book. */
export function inFlight(book: string, now: number = Date.now()): number {
  sweep(now)
  let total = 0
  for (const r of held.values()) {
    if (r.book === book) total += r.amount
  }
  return total
}

/** What this book could still route right now. Never negative. */
export function headroom(asset: UnderlyingAsset, now: number = Date.now()): number {
  return Math.max(0, asset.routedCapUsd - inFlight(asset.symbol, now))
}

export interface Reserved {
  id: string
  book: string
  amount: number
}

export class RoutingCapExceeded extends Error {
  readonly code = 'routing_cap' as const
  constructor(
    readonly book: string,
    readonly requested: number,
    readonly available: number,
    readonly cap: number,
  ) {
    super(
      `${book}: routing ${requested} would exceed the ${cap} in-flight bound — ` +
        `${available} available`,
    )
    this.name = 'RoutingCapExceeded'
  }
}

/**
 * Claim routing capacity for this book, or refuse.
 *
 * Refuses before anything is built and before a wallet is prompted, which is
 * the only moment refusing is free. The caller releases when the swap resolves;
 * see `release`.
 */
export function reserve(
  asset: UnderlyingAsset,
  amount: number,
  now: number = Date.now(),
): Reserved {
  if (!isFinite(amount) || amount <= 0) {
    throw new RoutingCapExceeded(asset.symbol, amount, headroom(asset, now), asset.routedCapUsd)
  }
  const available = headroom(asset, now)
  if (amount > available) {
    throw new RoutingCapExceeded(asset.symbol, amount, available, asset.routedCapUsd)
  }
  const id = `${asset.symbol}#${++counter}`
  held.set(id, { book: asset.symbol, amount, expiresAt: now + RESERVATION_TTL_MS })
  return { id, book: asset.symbol, amount }
}

/**
 * Give the capacity back. Safe to call twice and safe to call on a reservation
 * that already expired — a caller in an error path should not have to know
 * which of those happened.
 */
export function release(reserved: Reserved | null | undefined): void {
  if (reserved) held.delete(reserved.id)
}

/** Every book's current in-flight total, for the monitor and the admin screen. */
export function routingExposure(
  assets: UnderlyingAsset[],
  now: number = Date.now(),
): Array<{ book: string; inFlight: number; cap: number; pctFull: number }> {
  return assets.map((a) => {
    const used = inFlight(a.symbol, now)
    return {
      book: a.symbol,
      inFlight: used,
      cap: a.routedCapUsd,
      pctFull: a.routedCapUsd > 0 ? (used / a.routedCapUsd) * 100 : 0,
    }
  })
}

/** Tests only. */
export function resetRoutingBudget(): void {
  held.clear()
  counter = 0
}
