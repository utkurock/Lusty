// Forward price for XLM.
// ----------------------
// Black-76 prices off the forward F, not spot S. XLM has no dated futures, but
// it has a perpetual swap (Binance XLMUSDT perp) whose funding rate encodes the
// market's carry. We annualize the last funding rate and roll spot forward to
// the option's expiry:
//
//     F = S · exp(fundingAnnual · T)
//
// Funding settles every 8h (3×/day), so fundingAnnual = fundingRate · 3 · 365.
// For short-dated XLM weeklies the basis is tiny (F ≈ S), but using the forward
// keeps the math correct and the derivation honest: we never pretend a risk-free
// rate we don't have.

const PREMIUM_INDEX_URL =
  'https://fapi.binance.com/fapi/v1/premiumIndex?symbol=XLMUSDT'

// Funding intervals per year: 3 settlements/day × 365 days.
const FUNDING_INTERVALS_PER_YEAR = 3 * 365

const CACHE_TTL_MS = 60_000

export interface ForwardInfo {
  /** Forward price at expiry (USD). */
  forward: number
  /** Spot used (USD). */
  spot: number
  /** Annualized funding rate (decimal) read from the perp. */
  fundingAnnual: number
  /** Where the carry came from, for the explainability panel. */
  source: 'perp-funding' | 'spot-fallback'
  /** Years to expiry used for the roll. */
  timeYears: number
}

let cache: { fundingAnnual: number; expires: number } | null = null

async function getFundingAnnual(now: number): Promise<number | null> {
  if (cache && cache.expires > now) return cache.fundingAnnual
  try {
    const r = await fetch(PREMIUM_INDEX_URL, { cache: 'no-store' })
    if (!r.ok) return cache?.fundingAnnual ?? null
    const j = await r.json()
    const rate = parseFloat(j.lastFundingRate)
    if (!isFinite(rate)) return cache?.fundingAnnual ?? null
    const fundingAnnual = rate * FUNDING_INTERVALS_PER_YEAR
    cache = { fundingAnnual, expires: now + CACHE_TTL_MS }
    return fundingAnnual
  } catch {
    return cache?.fundingAnnual ?? null
  }
}

/**
 * Forward price for a given spot and time-to-expiry. Funding comes from the
 * perp; if the perp feed is unreachable we fall back to F = S (carry = 0),
 * which is conservative and never fabricates a rate.
 */
export async function getForward(
  spot: number,
  timeYears: number,
  now: number = Date.now(),
): Promise<ForwardInfo> {
  const fundingAnnual = await getFundingAnnual(now)
  if (fundingAnnual === null) {
    return {
      forward: spot,
      spot,
      fundingAnnual: 0,
      source: 'spot-fallback',
      timeYears,
    }
  }
  return {
    forward: spot * Math.exp(fundingAnnual * timeYears),
    spot,
    fundingAnnual,
    source: 'perp-funding',
    timeYears,
  }
}
