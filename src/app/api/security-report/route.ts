import { NextResponse } from 'next/server'
import { insertSecurityReport } from '@/lib/db-queries'
import { durableRateLimit } from '@/lib/rate-limit'
import { getClientIp, isJsonRequest } from '@/lib/anti-spam'
import { sendAlert } from '@/lib/monitor/notify'
import { parseSecurityReport, reportAlert } from '@/lib/security-report'
import { reportRef } from '@/lib/adversarial'

// The adversarial window's on-site intake. Private: nothing submitted here is
// shown to anyone without an admin session, so it is a fit channel for a
// Critical or High finding as well as the rest. No link heuristic, unlike
// /api/feedback — a reproduction is mostly explorer links and that is fine.

const MIN_FILL_MS = 5000
const ALERTS_PER_HOUR = 20

export async function POST(req: Request) {
  if (!isJsonRequest(req)) {
    return NextResponse.json({ error: 'expected application/json' }, { status: 415 })
  }
  try {
    const body = await req.json().catch(() => null)

    // Honeypot and timing trap, answered with a fake success so a bot does
    // not learn which one caught it. Nobody fills this form in five seconds.
    if (body && typeof body.website === 'string' && body.website.trim() !== '') {
      return NextResponse.json({ ok: true, ref: null })
    }
    if (body && typeof body.elapsedMs === 'number' && body.elapsedMs < MIN_FILL_MS) {
      return NextResponse.json({ ok: true, ref: null })
    }

    const parsed = parseSecurityReport(body)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error, field: parsed.field }, { status: 400 })
    }

    const ip = getClientIp(req)
    const burst = await durableRateLimit(`security-report:ip:${ip ?? 'anon'}`, 600_000, 3)
    if (!burst.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${burst.retryAfter}s` },
        { status: 429 }
      )
    }
    const daily = await durableRateLimit(`security-report:ip:daily:${ip ?? 'anon'}`, 86_400_000, 10)
    if (!daily.ok) {
      return NextResponse.json({ error: 'daily report limit reached' }, { status: 429 })
    }

    const id = await insertSecurityReport({ ...parsed.report, ip })

    // The report is stored either way; a failed notification must not tell the
    // reporter it was lost, and the admin panel still lists it.
    //
    // Alerts are capped across everyone, not per IP: each one pages the
    // maintainers and spends the email quota, and however many addresses a
    // flood comes from, past this many an hour the admin panel is where they
    // are read.
    const alerts = await durableRateLimit('security-report:alerts', 3_600_000, ALERTS_PER_HOUR)
    if (alerts.ok) {
      await sendAlert(reportAlert(id, parsed.report)).catch(() => undefined)
    }

    return NextResponse.json({ ok: true, ref: reportRef(id) })
  } catch (e: any) {
    return NextResponse.json(
      { error: 'report failed', detail: e?.message ?? 'unknown' },
      { status: 500 }
    )
  }
}
