import { NextResponse } from 'next/server'
import { getPositionsForAddress, type DbPosition } from '@/lib/db-queries'
import { isValidStellarAddress } from '@/lib/utils'
import { rateLimit } from '@/lib/rate-limit'
import { expiryLabel } from '@/lib/expiries'
import {
  getPositionsOf,
  settlementPayout,
  VAULT_ID,
  type VaultPosition,
} from '@/lib/vault-contract'
import { fetchSettlements, type SettlementRecord } from '@/lib/contract-events'
import { getDailyCloses, closeOn, type DatedClose } from '@/lib/price-history'
import { realizedApr } from '@/lib/apr'

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
  /**
   * What settlement paid the writer and in which token, computed with the
   * contract's own arithmetic. Null while the position is still open.
   *
   * This is the field that answers the question a settled position otherwise
   * leaves hanging — an assigned call returns cash, not the XLM that went in,
   * and a screen that says only "settled: yes" reads exactly like a screen
   * saying the money never came back.
   */
  payout: { amount: number; asset: 'XLM' | 'LUSD' } | null
  /** Oracle price the contract settled against, when the event is still readable. */
  settlePrice: number | null
  settledAt: string | null
  /** The settle transaction, for a writer who wants to see it on the ledger. */
  settleHash: string | null
  /**
   * Where the APR beside it came from. `recorded` is the figure this server
   * measured when the position was written; `derived` is the same formula run
   * later against the day's closing price, for positions opened before the
   * rate was being recorded at all. Null when neither was possible — which is
   * shown as unknown, never as 0.00%.
   */
  aprSource: 'recorded' | 'derived' | null
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
    const [chain, mirror, settlements, closes] = await Promise.all([
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
      // Best-effort, and only ever additive: it carries the settlement price
      // and hash, never whether a position settled. The contract owns that.
      fetchSettlements().catch((err) => {
        console.warn('vault/positions: settlement events unavailable', err)
        return new Map<number, SettlementRecord>()
      }),
      // One series covers every row, however old. Only positions written
      // before the deposit route recorded an APR need it.
      getDailyCloses().catch((err) => {
        console.warn('vault/positions: price history unavailable', err)
        return [] as DatedClose[]
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
        positions: chain.map((p) =>
          merge(address, p, byPositionId.get(p.id), settlements.get(p.id), closes)
        ),
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
  mirror: DbPosition | undefined,
  settlement: SettlementRecord | undefined,
  closes: DatedClose[]
): PositionView {
  const openedAt = mirror?.createdAt ?? null
  const { apr, aprSource } = resolveApr(position, mirror, openedAt, closes)

  return {
    id: mirror?.depositHash ?? `position-${position.id}`,
    positionId: position.id,
    address,
    type: position.side,
    asset: position.side === 'call' ? 'XLM' : 'LUSD',
    collateralAmount: position.collateral,
    strikePrice: position.strike,
    apr,
    aprSource,
    spotAtOpen: mirror?.spotAtOpen ?? null,
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
    payout: settlementPayout(position),
    settlePrice: settlement?.priceUsd ?? null,
    settledAt: settlement?.at ?? null,
    settleHash: settlement?.txHash ?? null,
  }
}

/**
 * The APR to show beside this position's premium.
 *
 * Recorded first: that is the rate measured against the price the underlying
 * actually had when the position was written, and nothing computed afterwards
 * beats it. Failing that the same formula runs against the closing price for
 * the day it opened, which is what the older rows have — the engine's APR was
 * never written down for them, and printing 0.00% for a position that paid a
 * premium is worse than printing a figure a day's close can justify.
 *
 * A put needs no price at all: its collateral is already the capital.
 */
function resolveApr(
  position: VaultPosition,
  mirror: DbPosition | undefined,
  openedAt: number | null,
  closes: DatedClose[]
): { apr: number | null; aprSource: PositionView['aprSource'] } {
  if (mirror?.apr != null) return { apr: mirror.apr, aprSource: 'recorded' }
  if (openedAt == null) return { apr: null, aprSource: null }

  const derived = realizedApr({
    side: position.side,
    collateral: position.collateral,
    premium: position.premium,
    openedAt,
    expiry: position.expiry.getTime(),
    spotAtOpen: mirror?.spotAtOpen ?? closeOn(closes, openedAt),
  })
  return derived == null
    ? { apr: null, aprSource: null }
    : { apr: derived, aprSource: 'derived' }
}
