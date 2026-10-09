import { NextResponse } from 'next/server'
import { logEvent } from '@/lib/db-queries'
import { rateLimit } from '@/lib/rate-limit'
import { isValidStellarAddress } from '@/lib/utils'
import { getClientIp } from '@/lib/anti-spam'
import { cleanMetadata } from '@/lib/analytics-metadata'

// Events the client is allowed to fire. Keeping a whitelist prevents the
// public endpoint from being used to write arbitrary rows into the table.
const ALLOWED_EVENTS = new Set([
  'page_view',
  'wallet_connect',
  'wallet_disconnect',
  'earn_open',
  'swap_open',
  'feedback_open',
  'feedback_submit',
  'security_report_open',
  'security_report_submit',
  'faucet_open',
])

// An event is a name, a path and a few small fields. The body used to be read
// whole and `metadata` stored as whatever object arrived, so one request could
// write megabytes of jsonb; the limits below are what a real event needs.
const MAX_BODY_BYTES = 4096
export async function POST(req: Request) {
  try {
    const declared = Number(req.headers.get('content-length') ?? 0)
    if (declared > MAX_BODY_BYTES) {
      return NextResponse.json({ ok: false, error: 'too large' }, { status: 413 })
    }
    const text = await req.text()
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json({ ok: false, error: 'too large' }, { status: 413 })
    }
    let body: any = null
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    if (!body || typeof body.event !== 'string') {
      return NextResponse.json({ error: 'invalid event' }, { status: 400 })
    }

    const event = body.event.slice(0, 64)
    if (!ALLOWED_EVENTS.has(event)) {
      return NextResponse.json({ error: 'unknown event' }, { status: 400 })
    }

    // Keyed on the address the request came from, which the caller cannot
    // choose, and on everyone together. The session id is the caller's own
    // string, so a limit on it alone was a limit nobody had to respect.
    const ip = getClientIp(req) ?? 'anon'
    const perClient = rateLimit(`analytics:ip:${ip}`, 60_000, 120)
    const overall = perClient.ok ? rateLimit('analytics:all', 60_000, 3000) : perClient
    if (!perClient.ok || !overall.ok) {
      return NextResponse.json({ ok: false, error: 'rate limited' }, { status: 429 })
    }

    const session = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 64) : null
    const address =
      typeof body.address === 'string' && isValidStellarAddress(body.address)
        ? body.address
        : null
    const path = typeof body.path === 'string' ? body.path.slice(0, 256) : null
    const metadata = cleanMetadata(body.metadata)

    await logEvent({ event, address, path, sessionId: session, metadata })
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    // Analytics must never break the page — swallow and report soft failure.
    // The reason stays in the server log: a driver error names the database.
    console.error('analytics: event not recorded', e)
    return NextResponse.json({ ok: false }, { status: 200 })
  }
}
