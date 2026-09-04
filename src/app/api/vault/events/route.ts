import { NextResponse } from 'next/server'
import { fetchVaultEvents, type VaultEvent } from '@/lib/contract-events'
import { getPosition, settlementPayout } from '@/lib/vault-contract'
import { getRecentDeposits } from '@/lib/db-queries'
import { rateLimit } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const LIMIT = 25

/**
 * The vault's activity feed: the contract's own events, backfilled with the
 * deposits this application recorded when they landed.
 *
 * Soroban RPC retains roughly seven days of contract events. A vault whose last
 * deposit is older than that answered getEvents with an empty list, so the
 * dashboard showed three open positions above a panel reporting that nothing
 * had ever happened. The events are gone from the RPC; the transactions are
 * not, and every deposit row carries the hash of one.
 *
 * On-chain events win wherever both sources name the same transaction — they
 * carry the strike, the premium and the settlement the mirror never sees.
 *
 * Read-only; never signs or submits.
 */
export async function GET() {
  try {
    const rl = rateLimit('vault-events', 60_000, 120)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 }
      )
    }

    // Neither source may take the other down: the ledger read already swallows
    // its own errors, and a database that is unreachable must still leave the
    // live events on screen.
    const [chain, deposits] = await Promise.all([
      fetchVaultEvents(LIMIT),
      getRecentDeposits(LIMIT).catch((err) => {
        // Log rather than swallow: a mirror that silently returns nothing is
        // indistinguishable from a vault with no history, which is the exact
        // confusion this route exists to end.
        console.warn('vault/events: deposit mirror unavailable', err)
        return []
      }),
    ])

    // A settle event says how a position resolved and at what price, but not
    // what that paid — the amounts are in contract state, not in the event. The
    // feed is where a writer notices their money arrived, so the rows that
    // moved money are the last rows that should stay silent about it.
    await Promise.all(
      chain
        .filter((e) => e.kind === 'settle' && e.id != null)
        .map(async (e) => {
          try {
            const p = await getPosition(Number(e.id))
            e.side = p.side
            e.strikeUsd = p.strike
            e.releasedAmount = p.collateral
            e.payout = settlementPayout(p) ?? undefined
          } catch (err) {
            // The row still stands on the outcome and the price it already has.
            console.warn(`vault/events: could not read settled position ${e.id}`, err)
          }
        })
    )

    const onChainHashes = new Set(
      chain.map((e) => e.txHash).filter((h): h is string => !!h)
    )

    const mirrored: VaultEvent[] = deposits
      .filter((d) => !d.txHash || !onChainHashes.has(d.txHash))
      .map((d) => ({
        source: 'mirror',
        kind: 'deposit',
        id: d.positionId !== null ? String(d.positionId) : null,
        // The mirror records when a deposit landed, not which ledger closed it.
        ledger: 0,
        at: d.at,
        contractId: '',
        txHash: d.txHash ?? undefined,
        owner: d.address,
        amount: d.collateral,
        side: d.side,
        strikeUsd: d.strikeUsd ?? undefined,
        premiumCash: d.premium,
      }))

    const events = [...chain, ...mirrored]
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, LIMIT)

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
