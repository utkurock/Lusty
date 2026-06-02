import { NextResponse } from 'next/server'
import { getPositionsForAddress } from '@/lib/db-queries'
import { isValidStellarAddress } from '@/lib/utils'
import { rateLimit } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// A wallet's positions, read from the shared DB so they are visible — and
// claimable — from any device or browser. Replaces the old localStorage-only
// dashboard, which made positions invisible on a different machine.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const address = url.searchParams.get('address') ?? ''
    if (!isValidStellarAddress(address)) {
      return NextResponse.json({ error: 'invalid address' }, { status: 400 })
    }

    const rl = rateLimit(`positions:${address}`, 60_000, 60)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 }
      )
    }

    const positions = await getPositionsForAddress(address)
    return NextResponse.json(
      { ok: true, positions },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (e: any) {
    return NextResponse.json(
      { error: 'failed to load positions', detail: e?.message ?? 'unknown' },
      { status: 500 }
    )
  }
}
