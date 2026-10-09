import { NextResponse } from 'next/server'
import { errorRef } from '@/lib/api-error'
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { LUSD_CODE, LUSD_ISSUER, LUSD_DISTRIBUTOR } from '@/lib/lusd'
import { ANCHOR_ASSET_CODE, ANCHOR_ASSET_ISSUER, BRIDGE_MIN_AMOUNT } from '@/lib/anchor/config'
import {
  isBridgeDirection,
  legsOf,
  verifyBridgeFunding,
  type BridgeDirection,
} from '@/lib/anchor/bridge-proof'
import type { ProofOperation, ProofTransaction } from '@/lib/swap-proof'
import { confirmAction, holdUnconfirmed, releaseAction, reserveAction } from '@/lib/idempotency'
import { submitPayout } from '@/lib/payout-submit'
import { logTransaction } from '@/lib/db-queries'
import { durableRateLimit } from '@/lib/rate-limit'
import { isValidStellarAddress } from '@/lib/utils'
import { ensureSchema, getPool } from '@/lib/db'

/** The one crossing this route pays out on; see below for why. */
const SERVED_DIRECTION: BridgeDirection = 'anchor_to_cash'

/**
 * The bridge between the anchor's asset and the vault's cash.
 *
 * A put can be funded in USDC; the vault escrows LUSD. Both are dollars on a
 * test network, so the bridge trades USDC for LUSD one for one — no oracle, no
 * spread, nothing to quote. Only that direction is served: LUSD is free from
 * the faucet, so paying USDC out for it would let anyone drain the float the
 * USDC puts depend on, and since the TRY ramp was removed nothing asks for it. What is left is the part that is not
 * arithmetic: the distributor pays out against a payment the caller says they
 * made, and everything that decides whether that payment happened lives in
 * lib/anchor/bridge-proof, where a test can reach it.
 *
 * This route is deliberately its own file rather than a third direction on
 * /api/swap. The swap route prices XLM off a live feed and splits a fee; none
 * of that applies here, and adding a branch to it would put the venue's own
 * money path at risk for a feature that is not on it.
 */

const HORIZON = process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org'
const DISTRIBUTOR_SECRET = process.env.LUSD_DISTRIBUTOR_SECRET ?? ''

interface BridgeBody {
  address: string
  txHash: string
  direction: BridgeDirection
  sourceAmount: number
}

function assetFor(leg: { code: string; issuer: string }): Asset {
  return new Asset(leg.code, leg.issuer)
}

function balanceOf(account: Horizon.AccountResponse, leg: { code: string; issuer: string }): number {
  const held = account.balances.find(
    (b: any) => b.asset_code === leg.code && b.asset_issuer === leg.issuer
  ) as any
  return held ? parseFloat(held.balance) : 0
}

function configured(): string | null {
  if (!LUSD_ISSUER || !DISTRIBUTOR_SECRET) return 'the bridge is not configured on the server'
  if (!ANCHOR_ASSET_ISSUER) return 'no anchor asset issuer is configured'
  return null
}

/**
 * Can this crossing be paid right now?
 *
 * Asked before the user signs anything, because everything it checks fails
 * after the money has already moved otherwise: the database the replay guard
 * writes to, and the float the payout comes out of.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const direction = url.searchParams.get('direction')
  const amount = Number(url.searchParams.get('amount') ?? '0')

  if (!isBridgeDirection(direction) || direction !== SERVED_DIRECTION) {
    return NextResponse.json({ error: 'invalid direction' }, { status: 400 })
  }
  if (!isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: 'invalid amount' }, { status: 400 })
  }

  const missing = configured()
  if (missing) return NextResponse.json({ ready: false, reason: missing }, { status: 503 })

  try {
    // The payout reserves the funding hash against replay before it submits,
    // and that reservation is a write. A database nobody can reach stops the
    // crossing — after the payment has landed — unless it is checked here.
    await ensureSchema()
    await getPool().query('select 1')

    const { receives } = legsOf(direction)
    const server = new Horizon.Server(HORIZON)
    const dist = await server.loadAccount(Keypair.fromSecret(DISTRIBUTOR_SECRET).publicKey())
    const float = balanceOf(dist, receives)

    if (float < amount) {
      return NextResponse.json(
        {
          ready: false,
          reason: `the bridge is short of ${receives.code} right now (needs ${amount.toFixed(4)}, holds ${float.toFixed(4)})`,
          float: float.toFixed(7),
        },
        { status: 503 }
      )
    }

    return NextResponse.json(
      { ready: true, destAmount: amount.toFixed(7), float: float.toFixed(7) },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (e: any) {
    console.error('anchor bridge preflight failed:', e?.message ?? e)
    return NextResponse.json(
      { ready: false, reason: `the bridge is unavailable right now (${errorRef('bridge preflight', e)})` },
      { status: 503 }
    )
  }
}

export async function POST(req: Request) {
  // Hoisted so the catch below can name the funding transaction it failed on.
  let fundingHashForLog: string | undefined
  try {
    const body = (await req.json()) as BridgeBody
    fundingHashForLog = typeof body?.txHash === 'string' ? body.txHash : undefined

    if (!isValidStellarAddress(body.address)) {
      return NextResponse.json({ error: 'invalid address' }, { status: 400 })
    }
    if (!body.txHash || typeof body.txHash !== 'string') {
      return NextResponse.json({ error: 'missing txHash' }, { status: 400 })
    }
    if (!isBridgeDirection(body.direction) || body.direction !== SERVED_DIRECTION) {
      return NextResponse.json({ error: 'invalid direction' }, { status: 400 })
    }
    if (typeof body.sourceAmount !== 'number' || body.sourceAmount < BRIDGE_MIN_AMOUNT) {
      return NextResponse.json(
        { error: `the smallest crossing is ${BRIDGE_MIN_AMOUNT}` },
        { status: 400 }
      )
    }

    const missing = configured()
    if (missing) return NextResponse.json({ error: missing }, { status: 500 })

    // Ten crossings an hour per address, the same allowance the swap route gives.
    const rl = await durableRateLimit(`anchor-bridge:${body.address}`, 3600_000, 10)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 }
      )
    }

    const server = new Horizon.Server(HORIZON)
    const tx = await server.transactions().transaction(body.txHash).call().catch(() => null)
    const operations = tx
      ? (await server.operations().forTransaction(body.txHash).call()).records
      : []

    const proof = verifyBridgeFunding({
      tx: tx as ProofTransaction | null,
      operations: operations as ProofOperation[],
      direction: body.direction,
      address: body.address,
      sourceAmount: body.sourceAmount,
    })
    if (!('ok' in proof)) {
      return NextResponse.json({ error: proof.error, code: proof.code }, { status: proof.status })
    }

    // One for one, sized from the ledger's number and never from the caller's.
    const paidAmount = proof.paidAmount
    const { receives } = legsOf(body.direction)
    const payoutAsset = assetFor(receives)

    // Both payouts are issued assets, so both need somewhere to land. Said
    // before the replay guard is taken, so a missing trustline costs the user
    // nothing but a retry.
    const recipient = await server.loadAccount(body.address)
    const canHold = recipient.balances.some(
      (b: any) => b.asset_code === receives.code && b.asset_issuer === receives.issuer
    )
    if (!canHold) {
      return NextResponse.json(
        { error: `open a ${receives.code} trustline first`, code: 'no_trustline' },
        { status: 409 }
      )
    }

    const distributor = Keypair.fromSecret(DISTRIBUTOR_SECRET)
    const distAccount = await server.loadAccount(distributor.publicKey())
    if (balanceOf(distAccount, receives) < paidAmount) {
      return NextResponse.json(
        {
          error: `the bridge is short of ${receives.code} right now`,
          code: 'bridge_short',
        },
        { status: 503 }
      )
    }

    // The replay guard shares the swap route's action type on purpose: one
    // on-chain payment to the distributor funds a swap OR a crossing, never
    // both, and that exclusivity is enforced by the same unique index.
    const reservation = await reserveAction('swap', body.txHash)
    if (reservation.alreadyProcessed) {
      return NextResponse.json(
        {
          error: 'this payment has already been processed',
          code: 'already_processed',
        },
        { status: 409 }
      )
    }

    const payout = new TransactionBuilder(distAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: body.address,
          asset: payoutAsset,
          amount: paidAmount.toFixed(7),
        })
      )
      .setTimeout(60)
      .build()
    payout.sign(distributor)

    // The guard is released only when the network refused the payout. On a
    // timeout the payout may still land, and a released guard would pay this
    // funding hash again — see lib/payout-submit.
    const submission = await submitPayout(
      () => server.submitTransaction(payout as any) as Promise<{ hash: string }>,
      payout.hash().toString('hex')
    )
    if (submission.kind === 'rejected') {
      await releaseAction('swap', body.txHash)
      throw submission.error
    }
    if (submission.kind === 'unknown') {
      await holdUnconfirmed('swap', body.txHash, submission.hash)
      console.error(
        `anchor bridge: payout ${submission.hash} for funding tx ${body.txHash} is unconfirmed; guard kept. Reason:`,
        (submission.error as any)?.message ?? submission.error
      )
      return NextResponse.json(
        {
          error: 'the network did not confirm the payout in time; it may still land, so do not send again',
          code: 'payout_unconfirmed',
          payoutHash: submission.hash,
        },
        { status: 502 }
      )
    }
    const result = { hash: submission.hash }

    await confirmAction('swap', body.txHash, result.hash)

    // Write the crossing down. Both legs are on the ledger and can be looked
    // up by hash, but only this row can say the two were one movement — which
    // is what the wallet's own history has to show, next to the positions the
    // crossing went on to fund. A failed write is not a failed crossing, so it
    // is reported and not thrown.
    let warning: string | undefined
    try {
      const { pays } = legsOf(body.direction)
      await logTransaction({
        address: body.address,
        type: 'deposit',
        subtype: 'anchor_bridge',
        amount: paidAmount,
        asset: pays.code,
        txHash: body.txHash,
        premiumHash: result.hash,
        metadata: {
          direction: body.direction,
          from: pays.code,
          to: receives.code,
          received: paidAmount,
        },
      })
    } catch (dbErr: any) {
      warning = errorRef('bridge: not recorded', dbErr)
      console.error('anchor bridge: crossing not recorded:', dbErr)
    }

    return NextResponse.json({
      ok: true,
      sourceAmount: paidAmount.toFixed(7),
      destAmount: paidAmount.toFixed(7),
      payoutHash: result.hash,
      ...(warning ? { warning: `History not updated: ${warning}` } : {}),
    })
  } catch (e: any) {
    const extras = e?.response?.data?.extras
    const detail = extras?.result_codes ?? e?.response?.data?.title ?? errorRef('bridge', e)
    // A crossing that reaches here has already taken the user's payment: the
    // funding transaction is on the ledger and the payout is not. Name the hash
    // in the log, because it is the only record of what the protocol owes.
    console.error(
      `anchor bridge: FAILED AFTER INTAKE — funding tx ${fundingHashForLog ?? 'unknown'} is on the ledger and the payout is not. Reason:`,
      detail
    )
    return NextResponse.json({ error: 'the crossing failed', detail }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
