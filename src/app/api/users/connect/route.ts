import { NextResponse } from 'next/server'
import { Horizon } from '@stellar/stellar-sdk'
import { errorRef } from '@/lib/api-error'
import { upsertUser } from '@/lib/db-queries'
import { clientRateLimit } from '@/lib/rate-limit'
import { isValidStellarAddress } from '@/lib/utils'

const HORIZON = process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org'

// Records that a wallet connected. Nothing proves the caller holds the key, so
// what bounds this is who is asking and what they name. The limit used to be
// keyed on the address in the body — any number of fresh addresses, any number
// of rows, in `users` and in the limiter's own table — so it is now keyed on
// the client, in memory, under a ceiling for everyone. And only an account
// that exists on the network is recorded: a random valid key is not a user.
export async function POST(req: Request) {
  try {
    const { address } = await req.json()
    if (!isValidStellarAddress(address)) {
      return NextResponse.json({ error: 'invalid address' }, { status: 400 })
    }

    const burst = clientRateLimit(req, 'connect', 60_000, 10, 600)
    const hourly = burst.ok ? clientRateLimit(req, 'connect:hour', 3_600_000, 30) : burst
    if (!hourly.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${hourly.retryAfter}s` },
        { status: 429 }
      )
    }

    const exists = await new Horizon.Server(HORIZON)
      .loadAccount(address)
      .then(() => true)
      .catch(() => false)
    if (!exists) {
      return NextResponse.json({ ok: true, recorded: false })
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
