import { NextResponse } from 'next/server'
import { getPositionsForAddress, type DbPosition } from '@/lib/db-queries'
import { isValidStellarAddress } from '@/lib/utils'
import { rateLimit } from '@/lib/rate-limit'
import {
  getPositionsOf,
  getExposure,
  getVaultLimits,
  VAULT_ID,
  type VaultPosition,
} from '@/lib/vault-contract'
import { getSpotXlmUsd } from '@/lib/spot'
import { getMarketContext } from '@/lib/pricing-server'
import {
  aggregatePortfolio,
  daysUntil,
  type ExpiryBucket,
  type Leg,
} from '@/lib/portfolio'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// Portfolio-level risk for one wallet.
// ====================================
// /api/vault/positions answers "what do I hold"; this answers "what am I
// exposed to". Same source of truth — the contract's own state, degrading to
// the database mirror and saying which one answered — but aggregated, and
// re-priced against live market data rather than against whatever the market
// looked like on the day each position was opened.
//
// The arithmetic lives in lib/portfolio.ts so it can be tested without a chain
// or a price feed; this file is the I/O around it. Two conventions it enforces
// are documented there and matter to anyone reading the response: every Greek
// describes the WRITER (the wallet is short every option it opened), and call
// collateral never adds to put collateral because they are different tokens.
//
// Market data is fetched ONCE per request, not once per position. σ is a
// property of the underlying, and every expiry's forward comes off the same
// funding observation.

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const address = url.searchParams.get('address') ?? ''
    if (!isValidStellarAddress(address)) {
      return NextResponse.json({ error: 'invalid address' }, { status: 400 })
    }

    // Tighter than /positions: every call here also re-prices the book against
    // live market data, so it costs an upstream fetch as well as a chain read.
    const rl = rateLimit(`portfolio:${address}`, 60_000, 20)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 }
      )
    }

    // Each source is best-effort on its own, as in /positions: a database
    // outage must not hide positions the ledger can answer for, and vice versa.
    const [chain, mirror] = await Promise.all([
      VAULT_ID
        ? getPositionsOf(address).catch((err) => {
            console.warn('vault/portfolio: contract read failed', err)
            return null
          })
        : Promise.resolve(null),
      getPositionsForAddress(address).catch((err) => {
        console.warn('vault/portfolio: database read failed', err)
        return [] as DbPosition[]
      }),
    ])

    const { legs, incomplete } = chain
      ? { legs: chain.map(fromChain), incomplete: 0 }
      : fromMirror(mirror)

    // Losing the feed costs the Greeks, not the whole answer: collateral and
    // premium income are recorded facts that need no price to report.
    const market = await marketFor(legs).catch((err) => {
      console.warn('vault/portfolio: market data unavailable', err)
      return null
    })

    const summary = aggregatePortfolio(legs, market)

    // Only meaningful against contract state: comparing a mirror-derived
    // holding to the contract's own book invites a discrepancy that means
    // nothing to the reader.
    if (chain) await attachVaultLoad(summary.byExpiry)

    return NextResponse.json(
      {
        ok: true,
        source: chain ? 'contract' : 'database',
        ...(chain ? { contractId: VAULT_ID } : {}),
        address,
        asOf: Date.now(),
        // Mirror rows without a strike or expiry cannot be priced or bucketed.
        // They predate contract custody; reporting how many were left out
        // beats dropping them silently from a total the user reads as whole.
        ...(incomplete > 0 ? { unpricedLegacyRows: incomplete } : {}),
        market,
        ...summary,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (e: any) {
    return NextResponse.json(
      { error: 'failed to load portfolio', detail: e?.message ?? 'unknown' },
      { status: 500 }
    )
  }
}

/**
 * Fill each bucket in with the vault's total load at that expiry.
 *
 * This is the one figure on the screen that never touches the database: the
 * contract's `exposure(kind, expiry)` view is the same number `open` checks
 * against `max_expiry`, so "how full is this tenor" is answered by the thing
 * that will actually refuse the next deposit. The stats route derives its
 * equivalent from the deposit ledger, which is a mirror and can drift.
 *
 * Best-effort throughout. A wallet's own exposure is the point of the response
 * and must not be held hostage to an extra read; a failure here leaves `vault`
 * absent, which the UI renders as "unknown" rather than as zero.
 */
async function attachVaultLoad(buckets: ExpiryBucket[]): Promise<void> {
  if (buckets.length === 0) return
  try {
    const [limits, loads] = await Promise.all([
      getVaultLimits(),
      Promise.all(
        buckets.map(async (b) => {
          const expiry = new Date(b.expiryIso)
          const [callXlm, putUsd] = await Promise.all([
            getExposure('call', expiry),
            getExposure('put', expiry),
          ])
          return { callXlm, putUsd }
        })
      ),
    ])
    buckets.forEach((b, i) => {
      b.vault = {
        callXlm: loads[i].callXlm,
        putUsd: loads[i].putUsd,
        maxCallXlm: limits.maxExpiryCall,
        maxPutUsd: limits.maxExpiryPut,
      }
    })
  } catch (err) {
    console.warn('vault/portfolio: per-expiry exposure read failed', err)
  }
}

function fromChain(p: VaultPosition): Leg {
  return {
    side: p.side,
    collateral: p.collateral,
    strike: p.strike,
    expiry: p.expiry,
    premium: p.premium,
    settled: p.settled,
  }
}

function fromMirror(rows: DbPosition[]): { legs: Leg[]; incomplete: number } {
  const legs: Leg[] = []
  let incomplete = 0
  for (const row of rows) {
    if (row.strikePrice === null || row.expiryIso === null) {
      incomplete++
      continue
    }
    legs.push({
      side: row.type,
      collateral: row.collateralAmount,
      strike: row.strikePrice,
      expiry: new Date(row.expiryIso),
      premium: row.premium,
      settled: row.settled,
    })
  }
  return { legs, incomplete }
}

/**
 * Live market inputs for the whole book, fetched once.
 *
 * `getMarketContext` wants a tenor because it returns a forward for one. It
 * gets the nearest live expiry; `fundingAnnual` then carries the forward out
 * to the rest inside the aggregator. Returns null when there is nothing left
 * to price, which is a valid state and not an error — a wallet whose positions
 * have all expired has no market exposure to report.
 */
async function marketFor(legs: Leg[]) {
  const live = legs.filter((l) => !l.settled && daysUntil(l.expiry) > 0)
  if (live.length === 0) return null

  const spot = await getSpotXlmUsd()
  const nearest = Math.min(...live.map((l) => daysUntil(l.expiry)))
  const ctx = await getMarketContext(spot.price, nearest)

  return {
    spot: spot.price,
    spotSource: spot.source,
    sigmaRealized: ctx.sigmaRealized,
    sigmaOffered: ctx.sigmaOffered,
    fundingAnnual: ctx.fundingAnnual,
    forwardSource: ctx.forwardSource,
    volMethod: ctx.volMethod,
    volWindowDays: ctx.volWindowDays,
    asOf: ctx.asOf,
  }
}
