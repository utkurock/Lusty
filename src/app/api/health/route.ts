import { NextResponse } from 'next/server'
import { Horizon } from '@stellar/stellar-sdk'
import { LUSD_DISTRIBUTOR } from '@/lib/lusd'
import { getSpot, resetSpotCache } from '@/lib/spot'
import { allUnderlyings, enabledUnderlyings, type AssetIssue } from '@/lib/assets'
import { routingExposure } from '@/lib/routing/budget'
import { reconcileAll } from '@/lib/vault-limits'
import { isAdminRequest } from '@/lib/admin-auth'

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

// Which books are servable, and why the rest are not.
//
// A gated asset is invisible everywhere else: it is simply absent from the
// screens, which looks identical whether somebody has not filled in an env key
// yet or shipped a declaration that contradicts itself. This says which.
//
// Only `invalid` counts against the overall status. An asset nobody has
// finished wiring is a plan — BTC sat that way for most of the tranche — and
// turning the probe red for it would train everyone to ignore it. A
// declaration that cannot be right is a bug that reached a deployment, and
// that is worth waking somebody for.
interface AssetStatus {
  underlying: string
  enabled: boolean
  issues: AssetIssue[]
}

function checkAssets(): AssetStatus[] {
  return allUnderlyings().map((a) => ({
    underlying: a.symbol,
    enabled: a.enabled,
    issues: a.issues,
  }))
}

// Routing exposure per book: what is committed against the bound right now.
//
// Reported rather than scored. In-flight capacity is a state, not a fault — a
// full one refuses conversions and leaves everything else about the book
// working, so turning the probe red for it would say the venue is down when the
// venue is busy. The monitor pages on it; this answers "why was my conversion
// refused" without anyone needing the alert.
function checkRouting() {
  return routingExposure(enabledUnderlyings()).map((r) => ({
    underlying: r.book,
    inFlightUsd: Number(r.inFlight.toFixed(7)),
    capUsd: r.cap,
    pctFull: Number(r.pctFull.toFixed(2)),
    full: r.pctFull >= 100,
  }))
}

// One probe serves everyone who asks within this window. Each fresh probe
// reads Horizon, the database, every price feed and every book's limits, and
// the pool behind the database is three connections: answering each request
// with a probe of its own let anyone hold those connections and RPC quotas
// with a loop of GETs.
const CACHE_MS = 15_000
let cached: { at: number; report: Promise<HealthReport> } | null = null

type HealthReport = Awaited<ReturnType<typeof probe>>

function report(): Promise<HealthReport> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.report
  const fresh = probe()
  cached = { at: Date.now(), report: fresh }
  fresh.catch(() => {
    if (cached?.report === fresh) cached = null
  })
  return fresh
}

/**
 * A dependency's error text names hosts, database roles and pooler addresses.
 * Operators get it with an admin session; everyone else gets the verdict.
 */
function redact(r: HealthReport): HealthReport {
  const hide = <T extends { error?: string }>(c: T): T =>
    c.error ? { ...c, error: 'unavailable' } : c
  const c = r.components
  return {
    ...r,
    components: {
      ...c,
      horizon: hide(c.horizon),
      db: hide(c.db),
      priceFeeds: c.priceFeeds.map(hide),
      limits: c.limits.map(hide),
      priceFeed: c.priceFeed && hide(c.priceFeed),
    },
  }
}

export async function GET(req: Request) {
  const r = await report()
  const body = (await isAdminRequest(req)) ? r : redact(r)
  return NextResponse.json(body, {
    status: r.ok ? 200 : 503,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    },
  })
}

async function probe() {
  const [horizon, db, priceFeeds, limits] = await Promise.all([
    checkHorizon(),
    checkDb(),
    checkPriceFeeds(),
    checkLimits(),
  ])
  const assets = checkAssets()

  const tradeable = priceFeeds.filter((f) => f.enabled)
  const enabled = new Set<string>(
    allUnderlyings().filter((a) => a.enabled).map((a) => a.symbol)
  )
  const misconfigured = assets.filter((a) =>
    a.issues.some((i) => i.kind === 'invalid')
  )
  const allOk =
    horizon.ok &&
    db.ok &&
    misconfigured.length === 0 &&
    tradeable.every((f) => f.ok) &&
    limits.every((l) => l.ok || !enabled.has(l.underlying))

  return {
    ok: allOk,
    checkedAt: new Date().toISOString(),
    components: {
      horizon,
      db,
      assets,
      priceFeeds,
      limits,
      routing: checkRouting(),
      // The XLM feed under its old name, so an existing status check keeps
      // reading the field it has always read.
      priceFeed: priceFeeds.find((f) => f.underlying === 'XLM'),
    },
  }
}
