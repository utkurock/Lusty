import { NextResponse } from 'next/server'
import { insertFeedback, isDuplicateFeedback } from '@/lib/db-queries'
import { rateLimit } from '@/lib/rate-limit'
import { isValidStellarAddress } from '@/lib/utils'
import { getClientIp, spamReason } from '@/lib/anti-spam'

const ALLOWED_CATEGORIES = new Set(['general', 'bug', 'feature', 'ux', 'praise'])

// Minimum time a human needs between opening the widget and submitting.
// Bots post instantly; real users take seconds to type.
const MIN_FILL_MS = 1500

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body.message !== 'string') {
      return NextResponse.json({ error: 'message required' }, { status: 400 })
    }

    // ── Honeypot ──────────────────────────────────────────────────────
    // A hidden field no human ever sees. If it's filled, it's a bot. Return
    // a fake success so the bot doesn't learn it was caught and retry.
    if (typeof body.website === 'string' && body.website.trim() !== '') {
      return NextResponse.json({ ok: true })
    }

    // ── Timing trap ───────────────────────────────────────────────────
    // The widget stamps how long the form was open. Too-fast submits are bots.
    if (typeof body.elapsedMs === 'number' && body.elapsedMs < MIN_FILL_MS) {
      return NextResponse.json({ ok: true })
    }

    const message = body.message.trim().slice(0, 2000)
    if (message.length < 3) {
      return NextResponse.json({ error: 'message too short' }, { status: 400 })
    }

    // ── Content heuristic ─────────────────────────────────────────────
    // Silent reject (fake success): don't tell spammers which rule tripped.
    if (spamReason(message)) {
      return NextResponse.json({ ok: true })
    }

    const address =
      typeof body.address === 'string' && isValidStellarAddress(body.address)
        ? body.address
        : null

    const ip = getClientIp(req)

    // ── Rate limiting ─────────────────────────────────────────────────
    // Layer 1 — per IP, the hardest identity to rotate. A short burst window
    // plus a daily cap. IP is the primary defense; address is secondary
    // because a spammer can mint unlimited valid Stellar addresses.
    if (ip) {
      const burst = rateLimit(`feedback:ip:${ip}`, 60_000, 3)
      if (!burst.ok) {
        return NextResponse.json(
          { error: `rate limited — retry after ${burst.retryAfter}s` },
          { status: 429 }
        )
      }
      const daily = rateLimit(`feedback:ip:daily:${ip}`, 86_400_000, 20)
      if (!daily.ok) {
        return NextResponse.json(
          { error: 'daily feedback limit reached' },
          { status: 429 }
        )
      }
    }

    // Layer 2 — per address (or shared anon bucket when no wallet connected).
    const rl = rateLimit(`feedback:${address ?? 'anon'}`, 60_000, 5)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 }
      )
    }

    // ── Duplicate suppression ─────────────────────────────────────────
    // Same IP + identical message within 10 min: an accidental or automated
    // resubmit. Ack without inserting a second row.
    if (await isDuplicateFeedback(ip, message)) {
      return NextResponse.json({ ok: true })
    }

    const rating =
      typeof body.rating === 'number' && body.rating >= 1 && body.rating <= 5
        ? Math.round(body.rating)
        : null
    const category =
      typeof body.category === 'string' && ALLOWED_CATEGORIES.has(body.category)
        ? body.category
        : 'general'
    const path = typeof body.path === 'string' ? body.path.slice(0, 256) : null

    await insertFeedback({ address, rating, category, message, path, ip })
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json(
      { error: 'feedback failed', detail: e?.message ?? 'unknown' },
      { status: 500 }
    )
  }
}
