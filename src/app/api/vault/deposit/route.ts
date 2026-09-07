import { NextResponse } from 'next/server'
import { rateLimit } from '@/lib/rate-limit'
import { isValidStellarAddress } from '@/lib/utils'
import { reserveAction, releaseAction, confirmAction } from '@/lib/idempotency'
import { logTransaction } from '@/lib/db-queries'
import { getPosition } from '@/lib/vault-contract'
import { getSpot } from '@/lib/spot'
import { realizedApr } from '@/lib/apr'
import { requestedUnderlying } from '@/lib/assets'

export const dynamic = 'force-dynamic'

// Position indexer — no custody, no payouts.
// ==========================================
// The vault contract escrows the collateral, pays the premium and records the
// position, all inside the transaction the user signs. By the time this
// endpoint is called the position already exists on chain and nothing here can
// change it. Its only job is to mirror it into the database so the leaderboard
// and analytics have something to read.
//
// This route used to be the vault: it verified a classic payment into a
// server-held distributor account and then paid the premium out of that same
// account's secret key. That rail is gone. There is no key here, so there is
// no path from this server to a user's collateral — and a failure below costs
// the user nothing, because their position is already settled law on chain.
//
// Everything it reports is read back from contract state. A caller who lies
// about the amount, the strike or the side is contradicted by the ledger and
// rejected; a caller who lies about the owner is rejected too.

interface DepositBody {
  address: string
  /** Transaction that opened the position. */
  txHash: string
  /**
   * Contract-assigned position id. Numbered per instance and starting at 0 in
   * each, so it means nothing without the underlying below.
   */
  positionId: number
  /** Which underlying's vault the position was opened in. Absent means XLM. */
  asset?: string
  type: 'call' | 'put'
  collateralAmount: number
  strikePrice: number
  daysToExpiry: number
  expiryIso?: string
}

// Tolerance when comparing client-reported figures to contract state. Both
// sides round to stroops, so this only absorbs the last unit.
const UNIT_EPSILON = 1e-6

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as DepositBody

    if (!isValidStellarAddress(body.address)) {
      return NextResponse.json({ error: 'invalid address' }, { status: 400 })
    }
    if (!body.txHash || typeof body.txHash !== 'string') {
      return NextResponse.json({ error: 'missing txHash' }, { status: 400 })
    }
    if (
      typeof body.positionId !== 'number' ||
      !Number.isInteger(body.positionId) ||
      body.positionId < 0
    ) {
      return NextResponse.json({ error: 'missing positionId' }, { status: 400 })
    }
    // Resolved before the position is read, because the id is only meaningful
    // against one instance. A gated asset is refused here rather than falling
    // through to XLM's vault, where position #3 is somebody else's position.
    const asset = requestedUnderlying(body.asset)
    if (!asset) {
      // Naming an asset we do not serve is the caller's error; naming none and
      // still getting nothing means XLM itself has no vault configured, which
      // is ours.
      return body.asset
        ? NextResponse.json(
            { error: `${body.asset} is not a tradeable underlying`, code: 'asset_unavailable' },
            { status: 400 },
          )
        : NextResponse.json(
            { error: 'vault contract not configured on the server' },
            { status: 500 },
          )
    }

    const rl = rateLimit(`deposit:${body.address}`, 3600_000, 30)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 },
      )
    }

    // ---- read the position back from the ledger
    let position
    try {
      position = await getPosition(body.positionId, asset)
    } catch (readErr) {
      console.error('vault/deposit: position read failed', readErr)
      return NextResponse.json(
        {
          error: 'position not found on chain — it may still be settling',
          code: 'position_unreadable',
        },
        { status: 404 },
      )
    }

    // The ledger decides who owns this position, not the request body.
    if (position.owner !== body.address) {
      return NextResponse.json(
        { error: 'position belongs to a different address', code: 'owner_mismatch' },
        { status: 403 },
      )
    }
    if (position.side !== body.type) {
      return NextResponse.json(
        { error: 'position side does not match the claim', code: 'side_mismatch' },
        { status: 409 },
      )
    }
    if (
      typeof body.collateralAmount === 'number' &&
      Math.abs(position.collateral - body.collateralAmount) > UNIT_EPSILON
    ) {
      return NextResponse.json(
        {
          error: `on-chain collateral ${position.collateral} does not match claim ${body.collateralAmount}`,
          code: 'amount_mismatch',
        },
        { status: 409 },
      )
    }

    // ---- the rate this position paid
    //
    // Recorded now because it can only be recorded now: the APR is measured
    // against the underlying's value at open, and by tomorrow that price is
    // history nobody kept. A feed outage costs the row its APR, not its
    // existence — the deposit is indexed either way.
    let spotAtOpen: number | null = null
    try {
      spotAtOpen = (await getSpot(asset)).price
    } catch (spotErr) {
      console.warn('vault/deposit: spot unavailable, APR not recorded', spotErr)
    }
    const openApr =
      realizedApr({
        side: position.side,
        collateral: position.collateral,
        premium: position.premium,
        openedAt: Date.now(),
        expiry: position.expiry.getTime(),
        spotAtOpen,
      }) ?? undefined

    // ---- record it once
    //
    // Same replay ledger the old rail used, so a position can be indexed only
    // once no matter how many times the client retries.
    const reservation = await reserveAction('deposit', body.txHash)
    if (reservation.alreadyProcessed) {
      return NextResponse.json(
        { ok: true, alreadyIndexed: true, positionId: body.positionId },
        { status: 200 },
      )
    }

    try {
      await logTransaction({
        address: position.owner,
        type: 'deposit',
        subtype: position.side,
        amount: position.collateral,
        // The token the amount is denominated in: a call escrows the
        // underlying, a put escrows cash. Which book the row belongs to is a
        // separate question, and `underlying` is the only one that answers it.
        asset: position.side === 'call' ? asset.symbol : 'LUSD',
        underlying: asset.symbol,
        txHash: body.txHash,
        // Escrow and premium are one transaction now; there is no separate
        // payout to point at.
        premiumHash: body.txHash,
        premiumAmount: position.premium,
        metadata: {
          positionId: position.id,
          contractId: asset.contracts.vault,
          collateralAmount: position.collateral,
          strikePrice: position.strike,
          expiryIso: position.expiry.toISOString(),
          daysToExpiry: body.daysToExpiry,
          // The rate this position paid, and the price it was measured
          // against. Neither has a home on chain, and the client is not asked
          // for either: both are derived here from contract state and this
          // server's own feed, so a writer cannot mint themselves a headline
          // APR by posting one. Undefined when the feed was unreachable —
          // recorded as unknown, never as zero.
          apr: openApr,
          spotAtOpen: spotAtOpen ?? undefined,
          premium: position.premium,
          settled: position.settled,
          outcome: position.outcome,
          source: 'contract',
        },
      })
    } catch (dbErr: any) {
      // The position is on chain regardless. Release the reservation so a
      // retry can index it rather than leaving it permanently unrecorded.
      await releaseAction('deposit', body.txHash)
      console.error('vault/deposit: indexing failed', dbErr)
      return NextResponse.json(
        {
          ok: true,
          indexed: false,
          positionId: position.id,
          warning: `Position is open on chain but was not indexed: ${dbErr?.message ?? 'unknown DB error'}`,
        },
        { status: 200 },
      )
    }

    await confirmAction('deposit', body.txHash, body.txHash)

    return NextResponse.json({
      ok: true,
      indexed: true,
      positionId: position.id,
      depositHash: body.txHash,
      premium: position.premium.toFixed(4),
      strike: position.strike,
      expiry: position.expiry.toISOString(),
    })
  } catch (e: any) {
    console.error('vault/deposit failed', e)
    return NextResponse.json(
      { error: 'vault deposit indexing failed', detail: e?.message ?? 'unknown' },
      { status: 500 },
    )
  }
}
