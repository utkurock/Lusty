import { NextResponse } from 'next/server'
import { quoteLadder, quoteOptionLive } from '@/lib/pricing-server'
import { getSpotXlmUsd } from '@/lib/spot'
import { rateLimit } from '@/lib/rate-limit'
import { pricingInputsFor } from '@/lib/quote-inputs'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// Public quote endpoint — the single source of truth for both the earn UI and
// any auditor. Returns the exact premium/APR the vault will pay if the same
// parameters arrive at /api/vault/authorize, plus the full derivation (realized
// σ, the σ we sell at, the forward, the haircut) so "where does the APR come
// from?" has a concrete, verifiable answer.
//
// Two modes, and two ways to say which expiry:
//   GET ?side=call&expiry=2026-08-21T08:00:00.000Z            → ladder
//   GET ?side=call&expiry=…&strike=0.24                       → one strike
//   GET ?side=call&days=7[&util=0.4]                          → ladder
//   GET ?side=call&days=7&strike=0.24[&util=…]                → one strike
//
// PREFER `expiry`. It is the form the money path uses, because days AND pool
// utilization are then derived server-side from the one expiry — by the same
// function the co-signature calls (lib/quote-inputs.ts) — so the quote on
// screen was priced from the inputs the premium will actually be priced from.
// A caller-supplied `util` is a display convenience for auditors exploring the
// curve; it cannot raise a premium the vault pays, because /api/vault/authorize
// reprices from the expiry regardless of what was asked for here.
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
    const expiryRaw = url.searchParams.get('expiry')

    if (side !== 'call' && side !== 'put') {
      return NextResponse.json({ error: 'invalid side' }, { status: 400 })
    }

    let days: number
    let util: number
    if (expiryRaw !== null) {
      const expiryMs = new Date(expiryRaw).getTime()
      if (!isFinite(expiryMs) || expiryMs <= Date.now()) {
        return NextResponse.json({ error: 'invalid expiry' }, { status: 400 })
      }
      const inputs = await pricingInputsFor(side, expiryMs)
      if (inputs.daysToExpiry > 365) {
        return NextResponse.json({ error: 'expiry too far out' }, { status: 400 })
      }
      days = inputs.daysToExpiry
      util = inputs.utilization
    } else {
      days = Number(daysRaw)
      if (!isFinite(days) || days <= 0 || days > 365) {
        return NextResponse.json({ error: 'invalid days' }, { status: 400 })
      }
      // Utilization is optional; clamp to [0,1]. Absent → empty pool (max APR).
      const asked = Number(utilRaw)
      util = isFinite(asked) ? Math.max(0, Math.min(1, asked)) : 0
    }

    // Cheap shared rate limit so a public endpoint can't be used to pummel the
    // upstream price feeds through us.
    const rl = rateLimit('vault-quote:global', 60_000, 240)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 },
      )
    }

    const { price: spot, source: spotSource } = await getSpotXlmUsd()

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
      return NextResponse.json(
        { ok: true, spot, spotSource, days, utilization: util, quote: slimQuote(quote) },
        { headers },
      )
    }

    // Ladder mode
    const { rungs } = await quoteLadder(side, spot, days, util)
    return NextResponse.json(
      {
        ok: true,
        spot,
        spotSource,
        // Echoed so a caller can see what its quote was priced against — and,
        // when it passed `expiry`, what the server derived on its behalf.
        days,
        utilization: util,
        strikes: rungs.map(slimRung),
      },
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
//
// Delta and vega are published because the dashboard has to show risk it did
// not compute itself — the criterion is that the screen matches this engine's
// output, which it cannot do if it re-derives the numbers client-side. They are
// the option's Greeks, holder's side; the UI negates for the writer.
//
// `sigmaStrike` stays out on purpose. Publishing the Greeks gives away the
// shape of the sensitivity, publishing σ_K gives away the level we price at,
// and the second is the input the smile and the vol spread are built on.
function slimRung(r: any) {
  return {
    index: r.index,
    strike: r.strike,
    label: r.label,
    apr: r.apr,
    userPremium: r.userPremium,
    delta: r.delta,
    vega: r.vega,
  }
}
function slimQuote(q: any) {
  return {
    strike: q.strike,
    daysToExpiry: q.daysToExpiry,
    apr: q.apr,
    userPremium: q.userPremium,
    delta: q.delta,
    vega: q.vega,
  }
}

