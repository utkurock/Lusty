import { NextResponse } from 'next/server'
import { fetchVaultEvents } from '@/lib/contract-events'
import { rateLimit } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// Streams the vault contract's on-chain events (deposit / settle / fund) out
// of the ledger for the live activity feed. Read-only; never signs or submits.
export async function GET() {
  try {
    const rl = rateLimit('vault-events', 60_000, 120)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 }
      )
    }

    const events = await fetchVaultEvents(25)
    return NextResponse.json(
      { ok: true, events },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (e: any) {
    return NextResponse.json(
      { error: 'failed to load events', detail: e?.message ?? 'unknown' },
      { status: 500 }
    )
  }
}
