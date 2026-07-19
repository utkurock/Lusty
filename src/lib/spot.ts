// Live XLM/USD spot for the server rails.
// =======================================
// Every server-side price — the quote ladder, the premium a deposit actually
// pays, the swap rate — resolves through here. It used to be four verbatim
// copies of a bare `fetch(binance)` that threw on any non-200, which made
// Binance a single point of failure for the whole product: one 451 (Binance
// geo-blocks datacenter IPs, which is exactly what a Vercel deploy runs on) or
// one 429 and /api/vault/quote 500s, so the UI shows no price and no APR.
//
// Source order, and why:
//
//   1. Reflector oracle (lastprice). THE settlement source — the on-chain
//      Soroban vault reads this same feed — so quoting off it means the number
//      a user is shown comes from the same place the position later settles
//      against. It is also, measured, the faster of the two (~150ms vs ~255ms).
//   2. Binance spot ticker. Real-time and independent of Stellar RPC, so it
//      covers the case where Reflector is stale, RPC is down, or the oracle
//      stops publishing.
//
// If BOTH are unavailable we throw. There is no hardcoded price fallback on
// purpose: quoting off a made-up spot would mispay real premium, and failing
// the request is the honest outcome.
//
// Reflector publishes on a 5-minute grid, so its record is up to one period
// old by construction. We accept that for quoting but bound it — see
// MAX_STALENESS_SECS. Settlement keeps its own, looser bound in reflector.ts;
// the two jobs deliberately do not share a number.

import { reflectorLastPriceRecord } from './reflector'

const BINANCE_TICKER_URL =
  'https://api.binance.com/api/v3/ticker/price?symbol=XLMUSDT'

// How old a Reflector record may be and still price a live quote. Three
// publish periods — tolerates a couple of missed updates without letting a
// genuinely stalled feed quote against a moving market.
const MAX_STALENESS_SECS = num(process.env.SPOT_MAX_STALENESS_SECS, 900)

// A record timestamped in the future means clock skew (ours or the oracle's).
// One publish period of tolerance; beyond that the record is not trustworthy.
const MAX_FUTURE_SKEW_SECS = 300

// Collapse the burst of quotes a single page render fires into one upstream
// call. Short enough that the price on screen is still live.
const CACHE_TTL_MS = num(process.env.SPOT_CACHE_TTL_MS, 5_000)

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return isFinite(n) && n > 0 ? n : fallback
}

export type SpotSource = 'reflector' | 'binance'

export interface SpotQuote {
  /** XLM price in USD. */
  price: number
  /** Which feed produced it. */
  source: SpotSource
  /** Unix ms the price is as-of (oracle record time, or fetch time). */
  asOf: number
}

let cache: { value: SpotQuote; expires: number } | null = null

/** Drops the memoized price. Tests only. */
export function resetSpotCache(): void {
  cache = null
}

/**
 * Source selection, extracted as a pure function so the precedence and the
 * staleness rules are unit-testable without touching the network.
 *
 * `reflector` is the raw oracle record (null if the call failed or returned
 * nothing), `binance` the ticker price (null if that call failed).
 */
export function pickSpot(
  reflector: { price: number; timestamp: number } | null,
  binance: number | null,
  now: number,
): SpotQuote | null {
  if (reflector && isFinite(reflector.price) && reflector.price > 0) {
    const ageSecs = Math.floor(now / 1000) - reflector.timestamp
    if (ageSecs <= MAX_STALENESS_SECS && ageSecs >= -MAX_FUTURE_SKEW_SECS) {
      return {
        price: reflector.price,
        source: 'reflector',
        asOf: reflector.timestamp * 1000,
      }
    }
    console.warn(
      `spot: reflector record ${ageSecs}s off (bound ${MAX_STALENESS_SECS}s) — falling back to binance`,
    )
  }
  if (binance !== null && isFinite(binance) && binance > 0) {
    return { price: binance, source: 'binance', asOf: now }
  }
  return null
}

async function fromReflector(): Promise<{
  price: number
  timestamp: number
} | null> {
  try {
    return await reflectorLastPriceRecord()
  } catch (e) {
    console.warn('spot: reflector unavailable —', (e as Error)?.message)
    return null
  }
}

async function fromBinance(): Promise<number | null> {
  try {
    const r = await fetch(BINANCE_TICKER_URL, { cache: 'no-store' })
    if (!r.ok) {
      console.warn(`spot: binance ticker ${r.status}`)
      return null
    }
    const j = await r.json()
    const n = parseFloat(j.price)
    return isFinite(n) && n > 0 ? n : null
  } catch (e) {
    console.warn('spot: binance unreachable —', (e as Error)?.message)
    return null
  }
}

/**
 * Live spot with its provenance. Throws only when every source is down —
 * callers should surface that as a 503-style "price feed unavailable" rather
 * than substituting a price of their own.
 */
export async function getSpotXlmUsd(now: number = Date.now()): Promise<SpotQuote> {
  if (cache && cache.expires > now) return cache.value

  // Reflector first; Binance is only paid for when Reflector cannot answer.
  const reflector = await fromReflector()
  let picked = pickSpot(reflector, null, now)
  if (!picked) picked = pickSpot(null, await fromBinance(), now)

  if (!picked) {
    throw new Error('price feed unavailable: reflector and binance both failed')
  }
  cache = { value: picked, expires: now + CACHE_TTL_MS }
  return picked
}

/** Just the number, for the many callers that don't care where it came from. */
export async function fetchXlmUsd(): Promise<number> {
  return (await getSpotXlmUsd()).price
}
