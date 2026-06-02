import { NextResponse } from 'next/server'
import { quoteLadder, quoteOptionLive } from '@/lib/pricing-server'
import { rateLimit } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// Public quote endpoint — the single source of truth for both the earn UI and
// any auditor. Returns the exact premium/APR the vault will pay if the same
// parameters arrive at /api/vault/deposit, plus the full derivation (realized
// σ, the σ we sell at, the forward, the haircut) so "where does the APR come
// from?" has a concrete, verifiable answer.
//
// Two modes:
//   GET ?side=call&days=7[&util=0.4]            → full strike ladder
//   GET ?side=call&days=7&strike=0.24[&util=…]  → single quote for one strike
//
// Spot is fetched server-side so a caller can't bias the quote with a stale or
// inflated price.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const side = url.searchParams.get('side')
    const strikeRaw = url.searchParams.get('strike')
    const daysRaw = url.searchParams.get('days')
    const utilRaw = url.searchParams.get('util')

    if (side !== 'call' && side !== 'put') {
      return NextResponse.json({ error: 'invalid side' }, { status: 400 })
    }
    const days = Number(daysRaw)
    if (!isFinite(days) || days <= 0 || days > 365) {
      return NextResponse.json({ error: 'invalid days' }, { status: 400 })
    }
    // Utilization is optional; clamp to [0,1]. Absent → empty pool (max APR).
    let util = Number(utilRaw)
    util = isFinite(util) ? Math.max(0, Math.min(1, util)) : 0

    // Cheap shared rate limit so a public endpoint can't be used to pummel
    // Binance through us.
    const rl = rateLimit('vault-quote:global', 60_000, 240)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 },
      )
    }

    const spot = await fetchXlmUsd()

    const headers = {
      // Quote depends on live spot; never cache.
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    }

    // Single-strike mode
    if (strikeRaw !== null) {
      const strike = Number(strikeRaw)
      if (!isFinite(strike) || strike <= 0) {
        return NextResponse.json({ error: 'invalid strike' }, { status: 400 })
      }
      const { quote } = await quoteOptionLive({
        side,
        spot,
        strike,
        daysToExpiry: days,
        utilization: util,
      })
      return NextResponse.json({ ok: true, spot, quote: slimQuote(quote) }, { headers })
    }

    // Ladder mode
    const { rungs } = await quoteLadder(side, spot, days, util)
    return NextResponse.json(
      { ok: true, spot, strikes: rungs.map(slimRung) },
      { headers },
    )
  } catch (e: any) {
    return NextResponse.json(
      { error: 'quote failed', detail: e?.message ?? 'unknown' },
      { status: 500 },
    )
  }
}

// Public DTOs — only the fields the UI needs to render and to compute the
// upfront it pays out. Internal pricing inputs (fair value, vol, the spread we
// keep) stay server-side; they're persisted with each deposit for our own audit
// trail but are not part of the public quote.
function slimRung(r: any) {
  return {
    index: r.index,
    strike: r.strike,
    label: r.label,
    apr: r.apr,
    userPremium: r.userPremium,
  }
}
function slimQuote(q: any) {
  return {
    strike: q.strike,
    daysToExpiry: q.daysToExpiry,
    apr: q.apr,
    userPremium: q.userPremium,
  }
}

async function fetchXlmUsd(): Promise<number> {
  const r = await fetch(
    'https://api.binance.com/api/v3/ticker/price?symbol=XLMUSDT',
    { cache: 'no-store' },
  )
  if (!r.ok) throw new Error('price feed unavailable')
  const j = await r.json()
  const n = parseFloat(j.price)
  if (!isFinite(n) || n <= 0) throw new Error('invalid price from feed')
  return n
}
