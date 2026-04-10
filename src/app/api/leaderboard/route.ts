import { NextResponse } from 'next/server'
import { getLeaderboard, getUserStats } from '@/lib/db-queries'
import { isValidStellarAddress } from '@/lib/utils'
import { rateLimit } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const rl = rateLimit('leaderboard:global', 60_000, 120)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 }
      )
    }

    const url = new URL(req.url)
    const rawLimit = parseInt(url.searchParams.get('limit') ?? '50', 10)
    const rawOffset = parseInt(url.searchParams.get('offset') ?? '0', 10)
    const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 50 : rawLimit), 200)
    const offset = Math.max(0, isNaN(rawOffset) ? 0 : rawOffset)
    const address = url.searchParams.get('address')

    // If address is provided, return that user's stats
    if (address) {
      if (!isValidStellarAddress(address)) {
        return NextResponse.json({ error: 'invalid address' }, { status: 400 })
      }
      const stats = await getUserStats(address)
      return NextResponse.json({ ok: true, user: stats })
    }

    const data = await getLeaderboard(limit, offset)
    return NextResponse.json({ ok: true, ...data })
  } catch (e: any) {
    return NextResponse.json(
      { error: 'leaderboard failed', detail: e?.message ?? 'unknown' },
      { status: 500 }
    )
  }
}
