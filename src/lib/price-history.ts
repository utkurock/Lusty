// Dated daily closes for an underlying.
// -------------------------------------
// lib/vol reads the same candles for σ and throws the timestamps away, because
// σ only needs the shape of the series. This needs the dates: it answers "what
// was the underlying worth on the day this position was opened", which is the
// denominator of a covered call's APR and the one figure about an old position
// that exists nowhere on chain.
//
// One fetch covers every position a wallet has ever written on one asset, so
// this is a cached call per asset rather than a lookup per row.

import { XLM, type UnderlyingAsset } from './assets'

/** Binance klines: [openTime, open, high, low, close, …]. */
const KLINES_URL = (symbol: string, limit: number) =>
  `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=${limit}`

const COINGECKO_URL = (coin: string, days: number) =>
  `https://api.coingecko.com/api/v3/coins/${coin}/market_chart?vs_currency=usd&days=${days}&interval=daily`

const SOURCE_TIMEOUT_MS = 8_000
const DAY_MS = 86_400_000
/** A year of candles: longer than any expiry this vault writes. */
const WINDOW_DAYS = 365
const CACHE_MS = 60 * 60_000

export interface DatedClose {
  /** Start of the UTC day the candle covers. */
  day: number
  close: number
}

// Per asset: one slot would answer a BTC position's "what was it worth that
// day" with XLM's close, which is the denominator of its APR.
const cache = new Map<string, { at: number; series: DatedClose[] }>()
const inFlight = new Map<string, Promise<DatedClose[]>>()

/** Truncate to the start of the UTC day, which is how the candles are keyed. */
export function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS
}

async function fromBinance(asset: UnderlyingAsset): Promise<DatedClose[] | null> {
  try {
    const r = await fetch(KLINES_URL(asset.binanceSymbol, WINDOW_DAYS), {
      cache: 'no-store',
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    })
    if (!r.ok) return null
    const rows = (await r.json()) as any[]
    if (!Array.isArray(rows)) return null
    const series = rows
      .map((row) => ({ day: utcDay(Number(row[0])), close: parseFloat(row[4]) }))
      .filter((d) => isFinite(d.day) && isFinite(d.close) && d.close > 0)
    return series.length > 0 ? series : null
  } catch {
    return null
  }
}

async function fromCoinGecko(asset: UnderlyingAsset): Promise<DatedClose[] | null> {
  try {
    const r = await fetch(COINGECKO_URL(asset.coingeckoId, WINDOW_DAYS), {
      cache: 'no-store',
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    })
    if (!r.ok) return null
    const j = (await r.json()) as { prices?: [number, number][] }
    if (!Array.isArray(j?.prices)) return null
    const series = j.prices
      .map(([t, p]) => ({ day: utcDay(t), close: p }))
      .filter((d) => isFinite(d.day) && isFinite(d.close) && d.close > 0)
    return series.length > 0 ? series : null
  } catch {
    return null
  }
}

/**
 * One underlying's daily closes, oldest first. Empty on a total source failure
 * — a missing series must leave an APR unknown, never zero, and never another
 * asset's close.
 */
export async function getDailyCloses(
  asset: UnderlyingAsset = XLM
): Promise<DatedClose[]> {
  const key = asset.symbol
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.series
  const pending = inFlight.get(key)
  if (pending) return pending

  const run = (async () => {
    const series = (await fromBinance(asset)) ?? (await fromCoinGecko(asset)) ?? []
    if (series.length > 0) cache.set(key, { at: Date.now(), series })
    return series
  })().finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, run)

  return run
}

/**
 * The close on the day `at` falls in, or the nearest earlier day the series
 * has. Null when nothing in the series is old enough — better an APR the
 * screen declines to state than one derived from the wrong week.
 */
export function closeOn(series: DatedClose[], at: number): number | null {
  if (series.length === 0) return null
  const want = utcDay(at)
  let best: DatedClose | null = null
  for (const d of series) {
    if (d.day > want) break
    best = d
  }
  // Within a week of the series, or not at all: a position opened before the
  // window starts has no close here and must say so.
  if (!best || want - best.day > 7 * DAY_MS) return null
  return best.close
}

/** Test seam. */
export function resetPriceHistoryCache(): void {
  cache.clear()
  inFlight.clear()
}
