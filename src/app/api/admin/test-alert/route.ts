import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sendAlert } from '@/lib/monitor/notify'

export const dynamic = 'force-dynamic'

/**
 * Manually fire a test alert through every configured channel. Admin-gated
 * (x-admin-token). Returns the per-channel delivery breakdown so an operator
 * can confirm the Slack webhook / email wiring works without waiting for a
 * real incident. Satisfies the P1-7 acceptance check: "test alert manually
 * triggered reaches Slack."
 */
export async function POST(req: Request) {
  const auth = requireAdmin(req)
  if (auth instanceof NextResponse) return auth

  const result = await sendAlert({
    severity: 'info',
    title: 'Test alert',
    message: `Manual test fired by ${auth}. If you can read this in Slack/email, alerting is wired up correctly.`,
    fields: [{ label: 'triggered_at', value: new Date().toISOString() }],
  })

  return NextResponse.json({ ok: true, ...result })
}
