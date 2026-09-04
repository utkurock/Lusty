// Dated daily closes for XLM.
// ---------------------------
// lib/vol reads the same candles for σ and throws the timestamps away, because
// σ only needs the shape of the series. This needs the dates: it answers "what
// was XLM worth on the day this position was opened", which is the denominator
// of a covered call's APR and the one figure about an old position that exists
// nowhere on chain.
//
// One fetch covers every position a wallet has ever written, so this is a
// single cached call rather than a lookup per row.

/** Binance klines: [openTime, open, high, low, close, …]. */
const KLINES_URL = (limit: number) =>
  `https://api.binance.com/api/v3/klines?symbol=XLMUSDT&interval=1d&limit=${limit}`

const COINGECKO_URL = (days: number) =>
  `https://api.coingecko.com/api/v3/coins/stellar/market_chart?vs_currency=usd&days=${days}&interval=daily`

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

let cache: { at: number; series: DatedClose[] } | null = null
let inFlight: Promise<DatedClose[]> | null = null

/** Truncate to the start of the UTC day, which is how the candles are keyed. */
export function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS
}

async function fromBinance(): Promise<DatedClose[] | null> {
  try {
    const r = await fetch(KLINES_URL(WINDOW_DAYS), {
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

async function fromCoinGecko(): Promise<DatedClose[] | null> {
  try {
    const r = await fetch(COINGECKO_URL(WINDOW_DAYS), {
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
 * XLM's daily closes, oldest first. Empty on a total source failure — a
 * missing series must leave an APR unknown, never zero.
 */
export async function getDailyCloses(): Promise<DatedClose[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.series
  if (inFlight) return inFlight

  inFlight = (async () => {
    const series = (await fromBinance()) ?? (await fromCoinGecko()) ?? []
    if (series.length > 0) cache = { at: Date.now(), series }
    return series
  })().finally(() => {
    inFlight = null
  })

  return inFlight
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
  cache = null
  inFlight = null
}
