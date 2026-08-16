// Browser side of the quote engine.
// =================================
// The earn screen must never compute a premium of its own — every number it
// shows, and the number it encodes into the transaction, comes from
// /api/vault/quote. This is the one place that calls it, so there is one place
// to check that the UI asks for a quote the way the money path prices one:
// by EXPIRY, letting the server derive days and pool utilization together
// (lib/quote-inputs.ts).
//
// Passing `days` and `util` from the browser is the older, weaker form: the
// client's utilization came from a stats poll that may not have landed yet, and
// a quote priced against a stale or fabricated utilization is a quote the
// co-signature will not reproduce.

export interface QuotedRung {
  index: number
  strike: number
  label: string
  apr: number
  /** Premium per unit of the underlying, in cash. */
  userPremium: number
  delta?: number
  vega?: number
}

export interface LadderQuote {
  spot: number
  /** Days the server priced against, derived from the expiry. */
  days: number
  /** Pool utilization the server priced against, derived from the expiry. */
  utilization: number
  strikes: QuotedRung[]
}

export interface StrikeQuote {
  strike: number
  daysToExpiry: number
  apr: number
  userPremium: number
  spot: number
  utilization: number
}

async function getQuote(
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<any> {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`/api/vault/quote?${qs}`, { signal, cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error ?? 'quote unavailable')
  }
  return data
}

/** Every strike on offer for one expiry, priced by the server. */
export async function fetchLadder(
  side: 'call' | 'put',
  expiryIso: string,
  signal?: AbortSignal,
): Promise<LadderQuote> {
  const d = await getQuote({ side, expiry: expiryIso }, signal)
  if (!Array.isArray(d.strikes) || d.strikes.length === 0) {
    throw new Error('quote returned no strikes')
  }
  return {
    spot: d.spot,
    days: d.days,
    utilization: d.utilization,
    strikes: d.strikes as QuotedRung[],
  }
}

/**
 * One strike, repriced now.
 *
 * Called immediately before a position is built, because the ladder on screen
 * is a snapshot: it was priced when the expiry was selected, and spot has moved
 * since. The number this returns is the one that goes into the transaction, so
 * what the vault pays is a quote the user's own screen can be reconciled
 * against rather than a stale one it happened to be holding.
 */
export async function fetchStrikeQuote(
  side: 'call' | 'put',
  expiryIso: string,
  strike: number,
  signal?: AbortSignal,
): Promise<StrikeQuote> {
  const d = await getQuote(
    { side, expiry: expiryIso, strike: String(strike) },
    signal,
  )
  const q = d.quote
  if (!q || typeof q.userPremium !== 'number' || !isFinite(q.userPremium)) {
    throw new Error('quote returned no premium')
  }
  return {
    strike: q.strike,
    daysToExpiry: q.daysToExpiry,
    apr: q.apr,
    userPremium: q.userPremium,
    spot: d.spot,
    utilization: d.utilization,
  }
}
