import { NextResponse } from 'next/server'
import { requestedUnderlying } from '@/lib/assets'
import { durableRateLimit } from '@/lib/rate-limit'
import { isValidStellarAddress } from '@/lib/utils'
import {
  prepareRoutedSwap,
  RoutedSwapRefused,
  settleRoutedSwap,
} from '@/lib/routing/session'

export const dynamic = 'force-dynamic'

/**
 * The writer's USDC into put cash, through Stellar's own liquidity.
 *
 * Two actions. `prepare` quotes the allowlisted route, reserves the book's
 * in-flight capacity and returns the transaction for the writer's wallet; it
 * moves nothing and signs nothing. `settle` reads the ledger and closes the
 * reservation, recording the fill only if a matching path payment is there.
 *
 * Nothing here pays out. The writer's own path payment is the whole swap, so
 * unlike the bridge this route holds no float and there is nothing to drain.
 * What it guards is the routing capacity and the journal the monitor reads.
 */
export async function POST(req: Request) {
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }

  if (body?.action === 'prepare') {
    if (!isValidStellarAddress(body.address)) {
      return NextResponse.json({ error: 'invalid address' }, { status: 400 })
    }
    const book = requestedUnderlying(body.asset)
    if (!book) {
      return NextResponse.json(
        { error: `${body.asset} is not a tradeable underlying`, code: 'asset_unavailable' },
        { status: 400 },
      )
    }
    const destAmount = Number(body.destAmount)
    if (!isFinite(destAmount) || destAmount <= 0) {
      return NextResponse.json({ error: 'invalid destAmount' }, { status: 400 })
    }
    // Each prepare holds routing capacity for up to two minutes, so this is
    // what bounds one address's share of a book.
    const rl = await durableRateLimit(`routing-prepare:${body.address}`, 3600_000, 20)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 },
      )
    }

    try {
      const prepared = await prepareRoutedSwap({ address: body.address, book, destAmount })
      return NextResponse.json({ ok: true, ...prepared }, { headers: { 'Cache-Control': 'no-store' } })
    } catch (e: any) {
      if (e instanceof RoutedSwapRefused) {
        // A refusal is the guardrails working, not the server failing: 409 so a
        // caller can tell "not at this price" from "not right now".
        return NextResponse.json({ ok: false, refused: true, code: e.code, error: e.message }, { status: 409 })
      }
      console.error('routing prepare failed:', e?.message ?? e)
      return NextResponse.json({ ok: false, error: 'could not prepare the swap' }, { status: 503 })
    }
  }

  if (body?.action === 'settle') {
    if (typeof body.id !== 'string' || body.id.length > 64) {
      return NextResponse.json({ error: 'invalid id' }, { status: 400 })
    }
    if (body.txHash !== undefined && !/^[0-9a-f]{64}$/i.test(String(body.txHash))) {
      return NextResponse.json({ error: 'invalid txHash' }, { status: 400 })
    }
    const settled = await settleRoutedSwap({
      id: body.id,
      txHash: body.txHash,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    })
    return NextResponse.json({ ok: true, ...settled }, { headers: { 'Cache-Control': 'no-store' } })
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
