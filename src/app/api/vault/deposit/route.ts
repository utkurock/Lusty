import { NextResponse } from 'next/server'
import { errorRef } from '@/lib/api-error'
import { durableRateLimit, rateLimit } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/anti-spam'
import { readJsonCapped, BodyTooLargeError } from '@/lib/request-body'
import { isValidStellarAddress } from '@/lib/utils'
import { reserveAction, releaseAction, confirmAction } from '@/lib/idempotency'
import { logTransaction } from '@/lib/db-queries'
import { getPosition } from '@/lib/vault-contract'
import { findOpenEvent } from '@/lib/contract-events'
import { realizedApr } from '@/lib/apr'
import { requestedUnderlying } from '@/lib/assets'
import { USDC_CODE } from '@/lib/usdc'
import { limitsRefusal } from '@/lib/vault-limits'
import { pricingDaysFor } from '@/lib/quote-inputs'
import { markReservationIndexed, reservedOpenPrice } from '@/lib/quote-policy'

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
// rejected; a caller who lies about the owner is rejected too. The one thing
// the caller supplies that the position does not carry — the transaction that
// opened it — is checked against the ledger as well: it must be the
// transaction that emitted this instance's `deposit` event for this id, or
// nothing is recorded.

interface DepositBody {
  address: string
  /**
   * Transaction that opened the position. Verified against the ledger's
   * `deposit` event for this position before anything is recorded.
   */
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
  /** Ignored: derived from the position's on-chain expiry and open time. */
  daysToExpiry?: number
  expiryIso?: string
  /**
   * The stablecoin the writer actually spent, when it was not the cash the
   * position escrows. A put's collateral is always the vault's cash; a writer
   * who picked USDC paid USDC and it was converted one for one on the way in,
   * and this is the only place that fact survives.
   *
   * A note, not a claim about the collateral: the conversion is its own
   * transaction, so contract state cannot corroborate it and nothing is
   * derived from it. Narrowed to a known stable below so an arbitrary string
   * cannot be written onto a position and rendered back.
   */
  fundedWith?: string
}

// Tolerance when comparing client-reported figures to contract state. Both
// sides round to stroops, so this only absorbs the last unit.
const UNIT_EPSILON = 1e-6

/** A Stellar transaction hash: 32 bytes, hex. */
const TX_HASH = /^[0-9a-f]{64}$/i

export async function POST(req: Request) {
  try {
    let parsed: DepositBody | null
    try {
      parsed = await readJsonCapped<DepositBody>(req)
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return NextResponse.json({ error: 'request body too large' }, { status: 413 })
      }
      throw err
    }
    if (!parsed || typeof parsed !== 'object') {
      return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
    }
    const body = parsed

    if (!isValidStellarAddress(body.address)) {
      return NextResponse.json({ error: 'invalid address' }, { status: 400 })
    }
    if (typeof body.txHash !== 'string' || !TX_HASH.test(body.txHash)) {
      return NextResponse.json({ error: 'invalid txHash' }, { status: 400 })
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

    // Same refusal the quote endpoint raises, repeated here because the money
    // path is reachable without one: a book whose limits do not reconcile with
    // its instance does not get written to.
    const unreconciled = await limitsRefusal(asset)
    if (unreconciled) {
      return NextResponse.json(
        { error: unreconciled, code: 'limits_unreconciled' },
        { status: 503 },
      )
    }

    // Per client throughout. The address in the body is anybody's to name, so
    // a budget keyed on it was one a stranger could spend for its owner — even
    // with a position id that does not exist. The cheap in-process limit sheds
    // a flood before it becomes contract reads; the durable one, after the
    // read, is the client's hourly budget.
    const ip = getClientIp(req) ?? 'anon'
    const readRl = rateLimit(`deposit-read:ip:${ip}`, 60_000, 30)
    if (!readRl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${readRl.retryAfter}s` },
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

    const rl = await durableRateLimit(`deposit:ip:${ip}`, 3600_000, 30)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 },
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

    // ---- when it opened, and at what price
    //
    // When it opened is the ledger's fact and what it was priced at is the
    // quoter's; when this request arrives is the caller's choice and decides
    // nothing. Both are settled before the replay key is reserved: a request
    // that cannot name the open transaction indexes nothing, so a stranger who
    // reaches an unindexed position first with a junk hash cannot freeze it
    // under that hash, unpriced. An answer that cannot be had right now is a
    // retry, never a guess.
    let opened: { at: number } | null
    try {
      opened = await findOpenEvent(asset.contracts.vault, position.id, body.txHash)
    } catch (rpcErr) {
      console.warn('vault/deposit: open not verifiable now', rpcErr)
      return NextResponse.json(
        { error: 'ledger unavailable — please retry', code: 'open_unverified' },
        { status: 503 },
      )
    }
    if (!opened) {
      return NextResponse.json(
        { error: 'txHash is not the transaction that opened this position', code: 'open_mismatch' },
        { status: 409 },
      )
    }
    const openedAt = opened.at
    const txHash = body.txHash.toLowerCase()

    // A call's collateral is valued at the spot the quoter signed against —
    // the signature that could have opened it, live at `openedAt`. Not the
    // feed now: that is the price on whatever day someone chose to index it.
    // None live means none known, and the row says so; a put needs no price.
    let spotAtOpen: number | null = null
    if (position.side === 'call') {
      try {
        spotAtOpen = await reservedOpenPrice({
          address: position.owner,
          underlying: asset.symbol,
          type: 'call',
          collateral: position.collateral,
          strike: position.strike,
          expiry: position.expiry,
          openedAt,
        })
      } catch (dbErr) {
        console.warn('vault/deposit: reservations unreadable', dbErr)
        return NextResponse.json(
          { error: 'pricing unavailable — please retry', code: 'open_unpriced' },
          { status: 503 },
        )
      }
    }
    const openApr =
      realizedApr({
        side: position.side,
        collateral: position.collateral,
        premium: position.premium,
        openedAt,
        expiry: position.expiry.getTime(),
        spotAtOpen,
      }) ?? undefined

    // ---- record it once
    //
    // Keyed on the position, which was just read off the ledger, and not on
    // the txHash. That is verified now, but the replay ledger's intake index
    // is shared with the swap desk and the bridge, and a position is one
    // position whichever string names it.
    const replayKey = `${asset.symbol}:${position.id}`
    const reservation = await reserveAction('deposit', replayKey)
    if (reservation.alreadyProcessed) {
      return NextResponse.json(
        { ok: true, alreadyIndexed: true, positionId: body.positionId },
        { status: 200 },
      )
    }

    try {
      // Recognised stables only, and only when it differs from what was
      // escrowed — "funded with LUSD" on an LUSD position is noise.
      const collateralCode = position.side === 'call' ? asset.symbol : 'LUSD'
      const fundedWith =
        body.fundedWith === USDC_CODE && body.fundedWith !== collateralCode
          ? USDC_CODE
          : null

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
        txHash,
        // Escrow and premium are one transaction now; there is no separate
        // payout to point at.
        premiumHash: txHash,
        premiumAmount: position.premium,
        metadata: {
          positionId: position.id,
          contractId: asset.contracts.vault,
          collateralAmount: position.collateral,
          strikePrice: position.strike,
          expiryIso: position.expiry.toISOString(),
          // The tenor it was priced at, from its own expiry and open time
          // rather than from the request.
          daysToExpiry: pricingDaysFor(position.expiry.getTime(), openedAt, asset),
          // The rate this position paid, and the price it was measured
          // against. Neither has a home on chain, and the client is not asked
          // for either: both are derived here from the ledger and the quote
          // that opened it, so a writer cannot mint themselves a headline APR
          // by posting one. Undefined when no live quote matched — recorded as
          // unknown, never as zero.
          apr: openApr,
          spotAtOpen: spotAtOpen ?? undefined,
          premium: position.premium,
          settled: position.settled,
          outcome: position.outcome,
          // Only when it says something the collateral does not.
          fundedWith: fundedWith ?? undefined,
          source: 'contract',
        },
      })
    } catch (dbErr: any) {
      // The position is on chain regardless. Release the reservation so a
      // retry can index it rather than leaving it permanently unrecorded.
      await releaseAction('deposit', replayKey)

      // Already indexed, under some other hash. The replay ledger is keyed on
      // the position, but a row may predate it; the unique index on
      // (underlying, positionId) answers either way. A duplicate is not a failure — the position is recorded,
      // which is what the caller wanted — so it is reported the same way a
      // repeated hash is.
      if (dbErr?.code === '23505') {
        return NextResponse.json(
          { ok: true, alreadyIndexed: true, positionId: position.id },
          { status: 200 },
        )
      }

      console.error('vault/deposit: indexing failed', dbErr)
      return NextResponse.json(
        {
          ok: true,
          indexed: false,
          positionId: position.id,
          warning: `Position is open on chain but was not indexed (${errorRef('vault/deposit: indexing', dbErr)})`,
        },
        { status: 200 },
      )
    }

    await confirmAction('deposit', replayKey, txHash)
    // The deposit row now counts this position; the quote's reservation stops.
    // Only when the row can count it in dollars, which the allowances are
    // stated in: an unpriced call adds nothing to a USD sum, so its
    // reservation keeps counting rather than the handoff understating.
    if (position.side === 'put' || spotAtOpen != null) {
      await markReservationIndexed({
        address: position.owner,
        underlying: asset.symbol,
        type: position.side,
        collateral: position.collateral,
        strike: position.strike,
        expiry: position.expiry,
      })
    }

    return NextResponse.json({
      ok: true,
      indexed: true,
      positionId: position.id,
      depositHash: txHash,
      premium: position.premium.toFixed(4),
      strike: position.strike,
      expiry: position.expiry.toISOString(),
    })
  } catch (e: any) {
    console.error('vault/deposit failed', e)
    return NextResponse.json(
      { error: 'vault deposit indexing failed', ref: errorRef('vault/deposit', e) },
      { status: 500 },
    )
  }
}
