import { NextResponse } from 'next/server'
import { logEvent } from '@/lib/db-queries'
import { rateLimit } from '@/lib/rate-limit'
import { isValidStellarAddress } from '@/lib/utils'

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
  'faucet_open',
])

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body.event !== 'string') {
      return NextResponse.json({ error: 'invalid event' }, { status: 400 })
    }

    const event = body.event.slice(0, 64)
    if (!ALLOWED_EVENTS.has(event)) {
      return NextResponse.json({ error: 'unknown event' }, { status: 400 })
    }

    // Rate-limit per session (falls back to event name) so a single client
    // cannot flood the table. Generous window — page views are frequent.
    const session = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 64) : null
    const rl = rateLimit(`analytics:${session ?? event}`, 60_000, 120)
    if (!rl.ok) {
      return NextResponse.json({ ok: false, error: 'rate limited' }, { status: 429 })
    }

    const address =
      typeof body.address === 'string' && isValidStellarAddress(body.address)
        ? body.address
        : null
    const path = typeof body.path === 'string' ? body.path.slice(0, 256) : null
    const metadata =
      body.metadata && typeof body.metadata === 'object' ? body.metadata : null

    await logEvent({ event, address, path, sessionId: session, metadata })
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    // Analytics must never break the page — swallow and report soft failure.
    return NextResponse.json(
      { ok: false, error: e?.message ?? 'unknown' },
      { status: 200 }
    )
  }
}
