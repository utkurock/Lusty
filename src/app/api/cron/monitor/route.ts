import { NextResponse } from 'next/server'
import { cronAuthorized } from '@/lib/cron-auth'
import { runMonitorChecks } from '@/lib/monitor/checks'
import { sendAlert } from '@/lib/monitor/notify'
import { applyAutoBreaker } from '@/lib/monitor/triggers'
import { purgeOldIps } from '@/lib/db-queries'
import { sweepLapsedReservations } from '@/lib/quote-policy'
import { getPositionsOf } from '@/lib/vault-contract'
import { settleableUnderlying } from '@/lib/assets'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const CRON_SECRET = process.env.CRON_SECRET ?? ''

/**
 * Scheduled risk-monitor sweep (P1-7). Driven by the deployment's own
 * scheduler, not by anything in this repository — the schedule is recorded in
 * the README. It used to name a `vercel.json` cron entry, which this deployment
 * never read; see /api/cron/settle for the longer version of that mistake.
 *
 * Auth: requires CRON_SECRET, supplied either as `Authorization: Bearer <s>`
 * (what most schedulers send) or, deprecated and logged, `?secret=<s>`. If CRON_SECRET is unset we fail
 * closed (403) rather than expose an unauthenticated endpoint that anyone
 * could spam to blast the alert channels.
 *
 * Only warning/critical alerts are delivered; info-level results are returned
 * in the response for debugging but not pushed, to keep the channels quiet.
 */
async function handle(req: Request) {
  if (!CRON_SECRET) {
    return NextResponse.json(
      { error: 'monitor disabled — CRON_SECRET not configured' },
      { status: 403 }
    )
  }
  if (!cronAuthorized(req, CRON_SECRET)) {
    return NextResponse.json({ error: 'not authorized' }, { status: 403 })
  }

  const alerts = await runMonitorChecks()
  const toDeliver = alerts.filter((a) => a.severity !== 'info')

  // Auto circuit breaker: trip/clear deposits based on the halt conditions
  // (vol spike, oracle stress, per-epoch loss cap). A state change is itself
  // a critical alert so operators see the kill-switch flip in real time.
  const breaker = await applyAutoBreaker()
  if (breaker.changed) {
    toDeliver.push({
      severity: 'critical',
      title: breaker.state.tripped ? 'Deposits auto-halted' : 'Deposits auto-resumed',
      message: breaker.state.tripped
        ? `Circuit breaker tripped automatically. ${breaker.state.reason ?? ''}`
        : 'Risk conditions normalized — deposits resumed automatically.',
      fields: breaker.evaluation.reasons.map((r, i) => ({
        label: `reason_${i + 1}`,
        value: r,
      })),
    })
  }

  // Housekeeping that rides on the same timer: client addresses on feedback and
  // security reports are kept for IP_RETENTION_DAYS and no longer. A failure
  // here is logged and never stops the risk sweep.
  const purged = await purgeOldIps().catch((e) => {
    console.error('monitor: ip retention purge failed', e)
    return null
  })

  // Lapsed quote reservations, for every wallet rather than only the ones
  // that come back to authorize: until it is settled against the chain a
  // lapsed signature still holds shared strike inventory, so one made under an
  // address nobody names again would hold it for the whole 14-day window. The
  // same fail-closed rule as at authorize time — a wallet whose positions
  // cannot be read keeps its reservations counting — and, like the purge
  // above, never allowed to stop the risk sweep.
  const reservations = await sweepLapsedReservations(async (address, underlying) => {
    const asset = settleableUnderlying(underlying)
    if (!asset) throw new Error(`no vault to read ${underlying} positions from`)
    return getPositionsOf(address, 100, asset)
  }).catch((e) => {
    console.error('monitor: lapsed reservation sweep failed', e)
    return null
  })

  const deliveries = await Promise.all(toDeliver.map((a) => sendAlert(a)))
  const delivered = deliveries.filter((d) => d.delivered).length

  return NextResponse.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    triggered: alerts.length,
    delivered,
    breaker: {
      tripped: breaker.state.tripped,
      source: breaker.state.source,
      changed: breaker.changed,
    },
    alerts: alerts.map((a) => ({ severity: a.severity, title: a.title })),
    ...(purged ? { ipsPurged: purged } : {}),
    ...(reservations ? { reservationsSwept: reservations } : {}),
  })
}

// Vercel cron issues GET; allow POST too for manual curl.
export const GET = handle
export const POST = handle
