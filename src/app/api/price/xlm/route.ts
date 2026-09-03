import { NextResponse } from 'next/server'
import { getSpotXlmUsd } from '@/lib/spot'
import { rateLimit } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * XLM/USD for the browser.
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
async function change24h(): Promise<number | null> {
  const t = 6_000
  try {
    const r = await fetch(
      'https://api.binance.com/api/v3/ticker/24hr?symbol=XLMUSDT',
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
      'https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd&include_24hr_change=true',
      { cache: 'no-store', signal: AbortSignal.timeout(t) }
    )
    if (r.ok) {
      const j = await r.json()
      const p = Number(j?.stellar?.usd_24h_change)
      if (isFinite(p)) return p
    }
  } catch {
    /* unknown, then */
  }
  return null
}

export async function GET() {
  const rl = rateLimit('price-xlm', 60_000, 240)
  if (!rl.ok) {
    return NextResponse.json(
      { error: `rate limited — retry after ${rl.retryAfter}s` },
      { status: 429 }
    )
  }

  try {
    // The price is required; the change is not, so a slow change source must
    // never hold up the number the page is actually waiting for.
    const [quote, chg] = await Promise.all([getSpotXlmUsd(), change24h()])
    return NextResponse.json(
      {
        ok: true,
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
    console.error('price/xlm: no source could answer', e)
    return NextResponse.json(
      { error: 'price unavailable', detail: e?.message ?? 'unknown' },
      { status: 503 }
    )
  }
}
