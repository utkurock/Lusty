// Realized volatility for XLM.
// ----------------------------
// XLM has no options market, so there is no implied-vol surface to read. The
// only honest σ we can produce comes from XLM's own price history. This module
// estimates annualized realized volatility from Binance daily candles using the
// RiskMetrics EWMA estimator (λ = 0.94), which weights recent returns more
// heavily so the quote reacts to the current regime instead of a stale average.
//
// Every quote's σ flows from here. The number is explainable end-to-end:
// "30-day close-to-close log returns, RiskMetrics EWMA λ=0.94, annualized ×√365".

const KLINES_URL = (limit: number) =>
  `https://api.binance.com/api/v3/klines?symbol=XLMUSDT&interval=1d&limit=${limit}`

// RiskMetrics decay. λ=0.94 ≈ 30-day effective center of mass — the industry
// default for daily data.
const EWMA_LAMBDA = 0.94

// Crypto trades 365 days/year (no market holidays), so daily vol annualizes
// with √365, not √252.
const ANNUALIZE = Math.sqrt(365)

// How many daily candles to pull. 60 gives the EWMA enough history to converge
// while staying recent.
const WINDOW_DAYS = 60

// Cache so a burst of quotes doesn't hammer Binance. Realized vol from daily
// candles barely moves intraday, so a few minutes is plenty.
const CACHE_TTL_MS = 5 * 60_000

export interface RealizedVol {
  /** Annualized realized volatility (decimal, e.g. 0.85 = 85%). */
  sigma: number
  /** Simple close-to-close annualized stdev over the window, for reference. */
  sigmaSimple: number
  /** Estimator label, for the explainability panel. */
  method: string
  /** Number of daily returns used. */
  samples: number
  /** Window length in days. */
  windowDays: number
  /** Unix ms the estimate was computed. */
  asOf: number
}

interface CacheEntry {
  value: RealizedVol
  expires: number
}

// Module-level cache (per server instance). `as any` avoids leaking the type
// into the public surface.
let cache: CacheEntry | null = null

/**
 * Close-to-close log returns → EWMA variance → annualized σ.
 * Returns are ordered oldest→newest so the EWMA recursion weights the most
 * recent return the most.
 */
function ewmaSigma(closes: number[]): { sigma: number; sigmaSimple: number; samples: number } {
  const rets: number[] = []
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) {
      rets.push(Math.log(closes[i] / closes[i - 1]))
    }
  }
  if (rets.length < 2) {
    return { sigma: 0, sigmaSimple: 0, samples: rets.length }
  }

  // Simple close-to-close stdev (population) for reference / sanity.
  const mean = rets.reduce((a, r) => a + r, 0) / rets.length
  const variance =
    rets.reduce((a, r) => a + (r - mean) * (r - mean), 0) / rets.length
  const sigmaSimple = Math.sqrt(variance) * ANNUALIZE

  // RiskMetrics EWMA: seed with the first squared return, then recurse.
  // We assume zero mean (standard for high-frequency-ish return vol).
  let ewmaVar = rets[0] * rets[0]
  for (let i = 1; i < rets.length; i++) {
    ewmaVar = EWMA_LAMBDA * ewmaVar + (1 - EWMA_LAMBDA) * rets[i] * rets[i]
  }
  const sigma = Math.sqrt(ewmaVar) * ANNUALIZE

  return { sigma, sigmaSimple, samples: rets.length }
}

/**
 * Fetch + estimate XLM realized vol. Cached for {@link CACHE_TTL_MS}.
 *
 * Throws if the feed is unavailable AND there is no cached value — callers on
 * the money path must fail closed rather than price off a fabricated σ.
 */
export async function getRealizedVol(now: number = Date.now()): Promise<RealizedVol> {
  if (cache && cache.expires > now) return cache.value

  const r = await fetch(KLINES_URL(WINDOW_DAYS), { cache: 'no-store' })
  if (!r.ok) {
    if (cache) return cache.value // serve stale rather than fabricate
    throw new Error('realized-vol: klines feed unavailable')
  }
  const rows = (await r.json()) as any[]
  if (!Array.isArray(rows) || rows.length < 3) {
    if (cache) return cache.value
    throw new Error('realized-vol: insufficient candle history')
  }

  // Kline row: [openTime, open, high, low, close, volume, ...]. Use close (idx 4).
  const closes = rows
    .map((row) => parseFloat(row[4]))
    .filter((c) => isFinite(c) && c > 0)

  const { sigma, sigmaSimple, samples } = ewmaSigma(closes)
  if (!isFinite(sigma) || sigma <= 0) {
    if (cache) return cache.value
    throw new Error('realized-vol: computed σ invalid')
  }

  const value: RealizedVol = {
    sigma,
    sigmaSimple,
    method: `close-to-close log returns, RiskMetrics EWMA λ=${EWMA_LAMBDA}, annualized ×√365`,
    samples,
    windowDays: WINDOW_DAYS,
    asOf: now,
  }
  cache = { value, expires: now + CACHE_TTL_MS }
  return value
}
