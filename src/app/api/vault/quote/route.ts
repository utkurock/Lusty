import { NextResponse } from 'next/server'
import { quoteOption } from '@/lib/pricing-server'
import { rateLimit } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// Public quote endpoint. Returns the exact premium the vault will pay if
// the same parameters arrive at /api/vault/deposit. Lets the UI display
// server-canonical numbers (no client/server premium drift) and lets
// auditors verify pricing without reading the source.
//
// Spot is fetched server-side so the caller can't bias the quote by
// supplying a stale or inflated price.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const side = url.searchParams.get('side')
    const strikeRaw = url.searchParams.get('strike')
    const daysRaw = url.searchParams.get('days')

    if (side !== 'call' && side !== 'put') {
      return NextResponse.json({ error: 'invalid side' }, { status: 400 })
    }
    const strike = Number(strikeRaw)
    if (!isFinite(strike) || strike <= 0) {
      return NextResponse.json({ error: 'invalid strike' }, { status: 400 })
    }
    const days = Number(daysRaw)
    if (!isFinite(days) || days <= 0 || days > 365) {
      return NextResponse.json({ error: 'invalid days' }, { status: 400 })
    }

    // Cheap shared rate limit so a public endpoint can't be used to
    // pummel Binance through us. Per-IP would be better but rate-limit.ts
    // is keyed by string and we don't have IP plumbing here yet.
    const rl = rateLimit('vault-quote:global', 60_000, 240)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 }
      )
    }

    const spot = await fetchXlmUsd()
    const q = quoteOption({ side, spot, strike, daysToExpiry: days })

    return NextResponse.json(
      {
        ok: true,
        ...q,
      },
      {
        headers: {
          // Quote depends on live spot; never cache.
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        },
      }
    )
  } catch (e: any) {
    return NextResponse.json(
      { error: 'quote failed', detail: e?.message ?? 'unknown' },
      { status: 500 }
    )
  }
}

async function fetchXlmUsd(): Promise<number> {
  const r = await fetch(
    'https://api.binance.com/api/v3/ticker/price?symbol=XLMUSDT',
    { cache: 'no-store' }
  )
  if (!r.ok) throw new Error('price feed unavailable')
  const j = await r.json()
  const n = parseFloat(j.price)
  if (!isFinite(n) || n <= 0) throw new Error('invalid price from feed')
  return n
}
