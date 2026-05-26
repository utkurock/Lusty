import { NextResponse } from 'next/server'
import { runMonitorChecks } from '@/lib/monitor/checks'
import { sendAlert } from '@/lib/monitor/notify'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const CRON_SECRET = process.env.CRON_SECRET ?? ''

/**
 * Scheduled risk-monitor sweep (P1-7). Wired to a Vercel cron in vercel.json.
 *
 * Auth: requires CRON_SECRET, supplied either as `Authorization: Bearer <s>`
 * (how Vercel cron sends it) or `?secret=<s>`. If CRON_SECRET is unset we fail
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
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  const qs = new URL(req.url).searchParams.get('secret')
  if (bearer !== CRON_SECRET && qs !== CRON_SECRET) {
    return NextResponse.json({ error: 'not authorized' }, { status: 403 })
  }

  const alerts = await runMonitorChecks()
  const toDeliver = alerts.filter((a) => a.severity !== 'info')

  const deliveries = await Promise.all(toDeliver.map((a) => sendAlert(a)))
  const delivered = deliveries.filter((d) => d.delivered).length

  return NextResponse.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    triggered: alerts.length,
    delivered,
    alerts: alerts.map((a) => ({ severity: a.severity, title: a.title })),
  })
}

// Vercel cron issues GET; allow POST too for manual curl.
export const GET = handle
export const POST = handle
