import { NextResponse } from 'next/server'
import { errorRef } from '@/lib/api-error'
import { upsertUser } from '@/lib/db-queries'
import { durableRateLimit } from '@/lib/rate-limit'
import { isValidStellarAddress } from '@/lib/utils'

export async function POST(req: Request) {
  try {
    const { address } = await req.json()
    if (!isValidStellarAddress(address)) {
      return NextResponse.json({ error: 'invalid address' }, { status: 400 })
    }

    const rl = await durableRateLimit(`connect:${address}`, 60_000, 10)
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
      { error: 'connect failed', ref: errorRef('users/connect', e) },
      { status: 500 }
    )
  }
}
