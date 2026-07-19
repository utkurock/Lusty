import { NextResponse } from 'next/server'
import { Horizon } from '@stellar/stellar-sdk'
import { LUSD_DISTRIBUTOR } from '@/lib/lusd'
import { getSpotXlmUsd, resetSpotCache } from '@/lib/spot'

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
async function checkPriceFeed(): Promise<ComponentStatus & { source?: string }> {
  const r = await timed(async () => {
    // Bypass the memo so health reflects the feeds right now, not a cached hit.
    resetSpotCache()
    return getSpotXlmUsd()
  })
  return {
    ok: r.ok,
    latencyMs: r.latencyMs,
    error: r.error,
    ...(r.value ? { source: r.value.source } : {}),
  }
}

export async function GET() {
  const [horizon, db, priceFeed] = await Promise.all([
    checkHorizon(),
    checkDb(),
    checkPriceFeed(),
  ])

  const allOk = horizon.ok && db.ok && priceFeed.ok

  return NextResponse.json(
    {
      ok: allOk,
      checkedAt: new Date().toISOString(),
      components: { horizon, db, priceFeed },
    },
    {
      status: allOk ? 200 : 503,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      },
    }
  )
}
