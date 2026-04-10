import { NextResponse } from 'next/server'
import { upsertUser } from '@/lib/db-queries'
import { rateLimit } from '@/lib/rate-limit'
import { isValidStellarAddress } from '@/lib/utils'

export async function POST(req: Request) {
  try {
    const { address } = await req.json()
    if (!isValidStellarAddress(address)) {
      return NextResponse.json({ error: 'invalid address' }, { status: 400 })
    }

    const rl = rateLimit(`connect:${address}`, 60_000, 10)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 }
      )
    }

    await upsertUser(address)
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json(
      { error: 'connect failed', detail: e?.message ?? 'unknown' },
      { status: 500 }
    )
  }
}
