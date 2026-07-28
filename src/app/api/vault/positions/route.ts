import { NextResponse } from 'next/server'
import { getPositionsForAddress, type DbPosition } from '@/lib/db-queries'
import { isValidStellarAddress } from '@/lib/utils'
import { rateLimit } from '@/lib/rate-limit'
import { expiryLabel } from '@/lib/expiries'
import { getPositionsOf, VAULT_ID, type VaultPosition } from '@/lib/vault-contract'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// A wallet's positions, with the ledger as the source of truth.
// =============================================================
// Everything that decides what a position IS — its side, collateral, strike,
// expiry, premium, and whether it has settled and how — is read from the vault
// contract's own state. The database is consulted only for what it alone
// recorded: the APR the quote engine published at deposit time, and the
// transaction hashes. Where the two disagree about a shared field the contract
// wins, because the contract is what will actually pay out.
//
// This is what makes a position portable. It lives on chain, indexed by owner
// in contract state, so it is visible from any device and readable by anyone —
// including after this server and its database are gone.
//
// If the contract cannot be reached the response degrades to the database
// mirror, flagged as such, rather than showing the user nothing.

export interface PositionView extends DbPosition {
  /** Contract-assigned id — what `settle(id)` takes. */
  positionId: number
  outcome: 'open' | 'kept' | 'assigned'
}

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

    // Each source is best-effort on its own: a database outage must not hide
    // positions that are perfectly readable from the ledger, and vice versa.
    const [chain, mirror] = await Promise.all([
      VAULT_ID
        ? getPositionsOf(address).catch((err) => {
            console.warn('vault/positions: contract read failed', err)
            return null
          })
        : Promise.resolve(null),
      getPositionsForAddress(address).catch((err) => {
        console.warn('vault/positions: database read failed', err)
        return [] as DbPosition[]
      }),
    ])

    if (!chain) {
      return NextResponse.json(
        { ok: true, source: 'database', positions: mirror },
        { headers: { 'Cache-Control': 'no-store' } }
      )
    }

    const byPositionId = new Map<number, DbPosition>()
    for (const row of mirror) {
      if (row.positionId !== null) byPositionId.set(row.positionId, row)
    }

    return NextResponse.json(
      {
        ok: true,
        source: 'contract',
        contractId: VAULT_ID,
        positions: chain.map((p) => merge(address, p, byPositionId.get(p.id))),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (e: any) {
    return NextResponse.json(
      { error: 'failed to load positions', detail: e?.message ?? 'unknown' },
      { status: 500 }
    )
  }
}

/**
 * Contract state, plus the off-chain fields it does not carry. Only the APR
 * and the transaction hashes come from the mirror — every economic field is
 * the ledger's.
 */
function merge(
  address: string,
  position: VaultPosition,
  mirror: DbPosition | undefined
): PositionView {
  return {
    id: mirror?.depositHash ?? `position-${position.id}`,
    positionId: position.id,
    address,
    type: position.side,
    asset: position.side === 'call' ? 'XLM' : 'LUSD',
    collateralAmount: position.collateral,
    strikePrice: position.strike,
    apr: mirror?.apr ?? null,
    premium: position.premium,
    depositHash: mirror?.depositHash ?? '',
    premiumHash: mirror?.premiumHash ?? null,
    expiryIso: position.expiry.toISOString(),
    expiryLabel: expiryLabel(position.expiry),
    daysToExpirySnapshot: mirror?.daysToExpirySnapshot ?? null,
    createdAt: mirror?.createdAt ?? position.expiry.getTime(),
    settled: position.settled,
    outcome: position.outcome,
    payoutHash: mirror?.payoutHash ?? null,
  }
}
