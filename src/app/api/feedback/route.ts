import { NextResponse } from 'next/server'
import { insertFeedback } from '@/lib/db-queries'
import { rateLimit } from '@/lib/rate-limit'
import { isValidStellarAddress } from '@/lib/utils'

const ALLOWED_CATEGORIES = new Set(['general', 'bug', 'feature', 'ux', 'praise'])

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body.message !== 'string') {
      return NextResponse.json({ error: 'message required' }, { status: 400 })
    }

    const message = body.message.trim().slice(0, 2000)
    if (message.length < 3) {
      return NextResponse.json({ error: 'message too short' }, { status: 400 })
    }

    const address =
      typeof body.address === 'string' && isValidStellarAddress(body.address)
        ? body.address
        : null

    // Rate-limit per address (or IP-less fallback) so the public endpoint
    // can't be spammed. Tight: feedback is a deliberate action.
    const rl = rateLimit(`feedback:${address ?? 'anon'}`, 60_000, 5)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 }
      )
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

    await insertFeedback({ address, rating, category, message, path })
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json(
      { error: 'feedback failed', detail: e?.message ?? 'unknown' },
      { status: 500 }
    )
  }
}
