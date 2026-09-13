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
async function change24h(asset: UnderlyingAsset): Promise<number | null> {
  const t = 6_000
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/ticker/24hr?symbol=${asset.binanceSymbol}`,
      { cache: 'no-store', signal: AbortSignal.timeout(t) }
    )
    if (r.ok) {
      const j = await r.json()
      const p = parseFloat(j?.priceChangePercent)
      if (isFinite(p)) return p
    }
  } catch {
    /* try the next one */
  }
  try {
    const r = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${asset.coingeckoId}&vs_currencies=usd&include_24hr_change=true`,
      { cache: 'no-store', signal: AbortSignal.timeout(t) }
    )
    if (r.ok) {
      const j = await r.json()
      const p = Number(j?.[asset.coingeckoId]?.usd_24h_change)
      if (isFinite(p)) return p
    }
  } catch {
    /* unknown, then */
  }
  return null
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
