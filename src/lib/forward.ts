// Forward price for an underlying.
// --------------------------------
// Black-76 prices off the forward F, not spot S. Neither underlying has dated
// futures, but each has a perpetual swap whose funding rate encodes the
// market's carry. We annualize the last funding rate and roll spot forward to
// the option's expiry:
//
//     F = S · exp(fundingAnnual · T)
//
// Funding settles every 8h (3×/day), so fundingAnnual = fundingRate · 3 · 365.
// For short-dated weeklies the basis is tiny (F ≈ S), but using the forward
// keeps the math correct and the derivation honest: we never pretend a risk-free
// rate we don't have. An asset whose perp cannot be read gets F = S, not a
// carry borrowed from another asset's funding.

import { XLM, type UnderlyingAsset } from './assets'

const PREMIUM_INDEX_URL = (symbol: string) =>
  `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`

// Funding intervals per year: 3 settlements/day × 365 days.
const FUNDING_INTERVALS_PER_YEAR = 3 * 365

const CACHE_TTL_MS = 60_000

// How long the perp feed may take before we give up on it. This is the ONE
// fetch on the quote path that used to carry no deadline at all, so when
// fapi.binance.com stops answering (it is unreachable from whole networks, and
// geo-blocks datacenter IPs besides) every quote sat on undici's 10s default
// connect timeout before falling back to F = S. The carry it returns moves a
// weekly premium by basis points; it is never worth seconds of latency.
const SOURCE_TIMEOUT_MS = 2_500

// After a failed read, stop asking for a while. Without this the failure is
// retried on EVERY quote — the timeout above bounds one request, but only a
// cooldown keeps a dead feed from taxing all of them.
const FAILURE_TTL_MS = 60_000

// How old the last good carry may be and still roll a forward while the perp
// feed is down. Funding resets every 8h; past one interval the rate being
// served is not the market's any more, and F = S is the honest fallback.
export const MAX_STALE_FUNDING_MS = 8 * 3600_000

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

// Keyed by asset: carry is a property of the underlying, and one slot would
// roll a BTC spot forward at XLM's funding rate.
const cache = new Map<string, { fundingAnnual: number; expires: number; fetchedAt: number }>()

// Per-asset "do not ask again before" stamp. Kept apart from `cache` so a
// cooldown never erases the last good carry: while the feed is down we still
// prefer a minute-old real funding rate over F = S.
const cooldown = new Map<string, number>()

/** Drops the memoized funding rates. Tests only. */
export function resetForwardCache(): void {
  cache.clear()
  cooldown.clear()
}

async function getFundingAnnual(
  asset: UnderlyingAsset,
  now: number,
): Promise<number | null> {
  const hit = cache.get(asset.symbol)
  if (hit && hit.expires > now) return hit.fundingAnnual

  // Last good carry while it is recent enough to stand for the market, or
  // null. Every give-up path below returns this.
  const stale =
    hit && now - hit.fetchedAt <= MAX_STALE_FUNDING_MS ? hit.fundingAnnual : null

  const until = cooldown.get(asset.symbol)
  if (until !== undefined && until > now) return stale

  const giveUp = (): number | null => {
    cooldown.set(asset.symbol, now + FAILURE_TTL_MS)
    return stale
  }

  try {
    const r = await fetch(PREMIUM_INDEX_URL(asset.binanceSymbol), {
      cache: 'no-store',
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    })
    if (!r.ok) return giveUp()
    const j = await r.json()
    const rate = parseFloat(j.lastFundingRate)
    if (!isFinite(rate)) return giveUp()
    const fundingAnnual = rate * FUNDING_INTERVALS_PER_YEAR
    cache.set(asset.symbol, { fundingAnnual, expires: now + CACHE_TTL_MS, fetchedAt: now })
    cooldown.delete(asset.symbol)
    return fundingAnnual
  } catch {
    return giveUp()
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
  asset: UnderlyingAsset = XLM,
  now: number = Date.now(),
): Promise<ForwardInfo> {
  const fundingAnnual = await getFundingAnnual(asset, now)
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
