import { NextResponse } from 'next/server'
import { getSpot } from '@/lib/spot'
import { rateLimit } from '@/lib/rate-limit'
import { resolveUnderlying, type UnderlyingAsset } from '@/lib/assets'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Spot for the browser, per underlying.
 *
 * Was /api/price/xlm, with the ticker and the CoinGecko id written into it. A
 * BTC screen reading that endpoint is not reading a slightly wrong price, it is
 * reading a price three orders of magnitude away — and every figure derived
 * from it, the USD value of a deposit above all, is wrong by the same factor
 * while looking perfectly ordinary.
 *
 * The client used to read Binance directly — a REST seed and a websocket — and
 * on any network where Binance is unreachable the header price never loaded at
 * all. That is a large part of the world, and it is not something the visitor
 * can do anything about.
 *
 * The server already resolves spot through Reflector first and Binance only as
 * a fallback (lib/spot.ts). Serving it from here gives every visitor the same
 * price the vault itself prices against, over the same origin as the rest of
 * the app, with no third-party host in the page's connect-src.
 *
 * The 24h change is best-effort: Reflector publishes a price, not a session, so
 * where the change is unknown it is reported as null rather than as zero. A
 * flat tape and an unknown one are different claims.
 */
/**
 * 24h change, best-effort and from whichever source answers.
 *
 * Reflector publishes a price, not a session, so the change has to come from
 * somewhere else. Both sources are tried and neither is required: an unknown
 * change is reported as null and the UI simply omits it.
 */
const CHANGE_TIMEOUT_MS = 2_500

async function binanceChange(asset: UnderlyingAsset): Promise<number | null> {
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/ticker/24hr?symbol=${asset.binanceSymbol}`,
      { cache: 'no-store', signal: AbortSignal.timeout(CHANGE_TIMEOUT_MS) }
    )
    if (!r.ok) return null
    const j = await r.json()
    const p = parseFloat(j?.priceChangePercent)
    return isFinite(p) ? p : null
  } catch {
    return null
  }
}

async function coingeckoChange(asset: UnderlyingAsset): Promise<number | null> {
  try {
    const r = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${asset.coingeckoId}&vs_currencies=usd&include_24hr_change=true`,
      { cache: 'no-store', signal: AbortSignal.timeout(CHANGE_TIMEOUT_MS) }
    )
    if (!r.ok) return null
    const j = await r.json()
    const p = Number(j?.[asset.coingeckoId]?.usd_24h_change)
    return isFinite(p) ? p : null
  } catch {
    return null
  }
}

/**
 * First source to produce a number wins; null once every one has given up.
 *
 * Deliberately a race rather than a fallback chain. Tried in order, an
 * unreachable first source makes the visitor wait out its whole timeout before
 * the second is even dialled, so one blocked host sets the floor on how fast
 * anybody's header can render. Nothing here is on the money path — the price
 * itself comes from lib/spot.ts — so there is no source to prefer, only a
 * fastest one.
 */
function firstAnswer(sources: Promise<number | null>[]): Promise<number | null> {
  return new Promise((resolve) => {
    let pending = sources.length
    let done = false
    if (pending === 0) return resolve(null)
    for (const source of sources) {
      source.then((value) => {
        if (done) return
        if (value !== null) {
          done = true
          resolve(value)
        } else if (--pending === 0) {
          done = true
          resolve(null)
        }
      })
    }
  })
}

// The change is a header decoration, identical for every visitor, and both
// sources meter their free tier by request. Un-cached, a busy minute spent the
// allowance on repeats of one number and CoinGecko started answering 429 —
// which reads downstream as "change unknown" and blanks the figure on screen
// for no reason. Successes are held for a minute; failures are held briefly
// too, so a rate-limited window costs one wait rather than one per request.
const CHANGE_CACHE_TTL_MS = 60_000
const CHANGE_FAILURE_TTL_MS = 20_000

const changeCache = new Map<string, { value: number | null; expires: number }>()

async function change24h(asset: UnderlyingAsset): Promise<number | null> {
  const now = Date.now()
  const hit = changeCache.get(asset.symbol)
  if (hit && hit.expires > now) return hit.value

  const value = await firstAnswer([binanceChange(asset), coingeckoChange(asset)])
  const ttl = value === null ? CHANGE_FAILURE_TTL_MS : CHANGE_CACHE_TTL_MS
  changeCache.set(asset.symbol, { value, expires: now + ttl })
  return value
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ asset: string }> },
) {
  const { asset: raw } = await params
  // A gated asset is refused rather than served XLM's price. The screen that
  // asked for it is the screen that would have shown the answer.
  const asset = resolveUnderlying(raw)
  if (!asset) {
    return NextResponse.json(
      { error: `${raw} is not a tradeable underlying` },
      { status: 404 }
    )
  }

  const rl = rateLimit(`price-${asset.symbol}`, 60_000, 240)
  if (!rl.ok) {
    return NextResponse.json(
      { error: `rate limited — retry after ${rl.retryAfter}s` },
      { status: 429 }
    )
  }

  try {
    // The price is required; the change is not, so a slow change source must
    // never hold up the number the page is actually waiting for.
    const [quote, chg] = await Promise.all([getSpot(asset), change24h(asset)])
    return NextResponse.json(
      {
        ok: true,
        asset: asset.symbol,
        price: quote.price,
        change24h: chg,
        source: quote.source,
        asOf: quote.asOf ?? Date.now(),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (e: any) {
    // Say so rather than serving a number nobody stands behind: a hardcoded
    // fallback price on a trading screen is worse than a blank one.
    console.error(`price/${asset.symbol}: no source could answer`, e)
    return NextResponse.json(
      { error: 'price unavailable', detail: e?.message ?? 'unknown' },
      { status: 503 }
    )
  }
}
