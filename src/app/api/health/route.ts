import { NextResponse } from 'next/server'
import { Horizon } from '@stellar/stellar-sdk'
import { LUSD_DISTRIBUTOR } from '@/lib/lusd'
import { getSpot, resetSpotCache } from '@/lib/spot'
import { allUnderlyings } from '@/lib/assets'
import { reconcileAll } from '@/lib/vault-limits'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// Lightweight liveness probe for the three external dependencies the vault
// touches on every deposit: Horizon (Stellar RPC), Postgres, and the spot
// price feed (Reflector oracle, with Binance behind it). Lets the UI show a
// "service degraded" banner instead of letting users discover the outage by
// hitting a 503 on deposit, and gives operations a single URL to point at for
// status checks.
//
// Returns 200 when all three are up, 503 when any are down. Each component
// reports its own ok flag and latency so the UI can be specific about
// what's failing.
//
// The price feed is per underlying, because there is no such thing as "the"
// price feed once a second asset is listed: BTC's Reflector record can go
// stale while XLM's is fine, and a single green tick would hide it. Only an
// asset the vault will actually write counts toward the overall status — a
// declared-but-gated one reports its state without failing the probe.

const HORIZON =
  process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org'

interface ComponentStatus {
  ok: boolean
  latencyMs: number
  error?: string
}

async function timed<T>(
  fn: () => Promise<T>
): Promise<{ ok: boolean; value: T | null; latencyMs: number; error?: string }> {
  const start = Date.now()
  try {
    const value = await fn()
    return { ok: true, value, latencyMs: Date.now() - start }
  } catch (e: any) {
    return {
      ok: false,
      value: null,
      latencyMs: Date.now() - start,
      error: e?.message ?? 'unknown',
    }
  }
}

async function checkHorizon(): Promise<ComponentStatus> {
  if (!LUSD_DISTRIBUTOR) {
    return { ok: false, latencyMs: 0, error: 'distributor not configured' }
  }
  const r = await timed(async () => {
    const server = new Horizon.Server(HORIZON)
    return server.loadAccount(LUSD_DISTRIBUTOR)
  })
  return { ok: r.ok, latencyMs: r.latencyMs, error: r.error }
}

async function checkDb(): Promise<ComponentStatus> {
  const r = await timed(async () => {
    const { getPool } = await import('@/lib/db')
    const pool = getPool()
    await pool.query('select 1')
  })
  return { ok: r.ok, latencyMs: r.latencyMs, error: r.error }
}

// Probes the same failover chain the money path uses, so a green health check
// means "a quote can be priced", not "one particular vendor answered". Reports
// which feed served it — with Reflector primary and Binance behind it, seeing
// `source: 'binance'` here is the early warning that the oracle went quiet.
interface FeedStatus extends ComponentStatus {
  underlying: string
  /** False when the asset is declared but not tradeable — see lib/assets. */
  enabled: boolean
  source?: string
  price?: number
}

async function checkPriceFeeds(): Promise<FeedStatus[]> {
  // Bypass the memo once so health reflects the feeds right now, not a
  // cached hit, then let the per-asset reads share that fresh window.
  resetSpotCache()
  return Promise.all(
    allUnderlyings().map(async (asset) => {
      const r = await timed(() => getSpot(asset))
      return {
        underlying: asset.symbol,
        enabled: asset.enabled,
        ok: r.ok,
        latencyMs: r.latencyMs,
        error: r.error,
        ...(r.value ? { source: r.value.source, price: r.value.price } : {}),
      }
    })
  )
}

// Whether each book's limits still agree with the instance enforcing them.
// A book that fails this is refusing quotes and deposits, so it belongs in the
// same place an operator already looks to find out why, and it counts against
// the overall status for the same reason a dead feed does: the vault is not
// writable.
interface LimitsStatus {
  underlying: string
  vault: string
  ok: boolean
  drift: string[]
  stale?: boolean
  error?: string
}

async function checkLimits(): Promise<LimitsStatus[]> {
  const all = await reconcileAll()
  return all.map((r) => ({
    underlying: r.symbol,
    vault: r.vault,
    ok: r.ok,
    drift: r.drift.map((d) => d.detail),
    ...(r.stale ? { stale: true } : {}),
    ...(r.error ? { error: r.error } : {}),
  }))
}

export async function GET() {
  const [horizon, db, priceFeeds, limits] = await Promise.all([
    checkHorizon(),
    checkDb(),
    checkPriceFeeds(),
    checkLimits(),
  ])

  const tradeable = priceFeeds.filter((f) => f.enabled)
  const enabled = new Set<string>(
    allUnderlyings().filter((a) => a.enabled).map((a) => a.symbol)
  )
  const allOk =
    horizon.ok &&
    db.ok &&
    tradeable.every((f) => f.ok) &&
    limits.every((l) => l.ok || !enabled.has(l.underlying))

  return NextResponse.json(
    {
      ok: allOk,
      checkedAt: new Date().toISOString(),
      components: {
        horizon,
        db,
        priceFeeds,
        limits,
        // The XLM feed under its old name, so an existing status check keeps
        // reading the field it has always read.
        priceFeed: priceFeeds.find((f) => f.underlying === 'XLM'),
      },
    },
    {
      status: allOk ? 200 : 503,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      },
    }
  )
}
