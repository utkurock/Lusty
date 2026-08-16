// The two derived inputs every premium is priced from.
// =====================================================
// A premium depends on the expiry twice over: how long the option has to run,
// and how full that expiry's pool already is. Both are derivable from the
// expiry alone — and both used to be derived twice, once by the browser and
// again by the co-signature, from different sources:
//
//   days   the UI computed from its own clock, the route from the server's
//   util   the UI read off /api/vault/stats, the route out of the DB — and
//          before stats resolved, the UI used a FABRICATED 0.68 (expiries.ts)
//
// Every one of those pairs can disagree, and a disagreement is money: the
// utilization taper alone spans a 2× range, so a UI priced against the mock
// showed — and, because the co-signature only ever refused a premium that was
// too HIGH, silently paid — around a third less than the position was worth.
//
// So the derivation lives here once. `/api/vault/quote` and
// `/api/vault/authorize` both call it with the same expiry and get the same
// two numbers, which is what makes "what's shown is what's paid" a property of
// the code rather than a coincidence between two clocks.

import { MIN_DAYS_TO_EXPIRY } from './expiries'
import { expiryUtilizationFor } from './vault-state'

export interface PricingInputs {
  /** Canonical UTC ISO expiry — the form the capacity buckets are keyed by. */
  expiryIso: string
  /** Days the engine prices against. */
  daysToExpiry: number
  /** Pool utilization for this expiry (0..1), from the protocol's own records. */
  utilization: number
}

/**
 * Days to price an expiry against: whole days, never fewer than the minimum
 * tenor the vault writes. Rounded UP so a long-dated premium can never be
 * bought for a short-dated lock, and so the browser and the server land on the
 * same integer from the same expiry.
 */
export function pricingDaysFor(expiryMs: number, now: number = Date.now()): number {
  return Math.max(MIN_DAYS_TO_EXPIRY, Math.ceil((expiryMs - now) / 86_400_000))
}

/**
 * Everything the engine needs about an expiry, for one side of the book.
 *
 * Never throws on the utilization read: `expiryUtilizationFor` answers a DB
 * outage with a nearly-full pool, which quotes low rather than quoting blind.
 * Both callers inherit that, so an outage moves the shown number and the paid
 * number together.
 */
export async function pricingInputsFor(
  side: 'call' | 'put',
  expiryMs: number,
  now: number = Date.now(),
): Promise<PricingInputs> {
  const expiryIso = new Date(expiryMs).toISOString()
  return {
    expiryIso,
    daysToExpiry: pricingDaysFor(expiryMs, now),
    utilization: await expiryUtilizationFor(side, expiryIso),
  }
}
