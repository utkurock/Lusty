import { NextResponse } from 'next/server'
import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  Networks,
  BASE_FEE,
} from '@stellar/stellar-sdk'
import { logTransaction } from '@/lib/db-queries'
import { rateLimit } from '@/lib/rate-limit'
import { isValidStellarAddress } from '@/lib/utils'

const HORIZON =
  process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org'
const LUSD_CODE = process.env.NEXT_PUBLIC_LUSD_CODE ?? 'LUSD'
const LUSD_ISSUER = process.env.NEXT_PUBLIC_LUSD_ISSUER ?? ''
const LUSD_DISTRIBUTOR = process.env.NEXT_PUBLIC_LUSD_DISTRIBUTOR ?? ''
const DISTRIBUTOR_SECRET = process.env.LUSD_DISTRIBUTOR_SECRET ?? ''

interface ClaimBody {
  address: string
  depositHash: string
  type: 'call' | 'put'
  collateralAmount: number
  strikePrice: number
  expiryIso: string
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ClaimBody

    // ---- validate
    if (!isValidStellarAddress(body.address)) {
      return NextResponse.json({ error: 'invalid address' }, { status: 400 })
    }
    if (!body.depositHash) {
      return NextResponse.json({ error: 'missing depositHash' }, { status: 400 })
    }

    // Rate limit: 10 claims per address per hour
    const rl = rateLimit(`claim:${body.address}`, 3600_000, 10)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 }
      )
    }
    if (body.type !== 'call' && body.type !== 'put') {
      return NextResponse.json({ error: 'invalid type' }, { status: 400 })
    }
    if (typeof body.collateralAmount !== 'number' || body.collateralAmount <= 0) {
      return NextResponse.json({ error: 'invalid amount' }, { status: 400 })
    }
    if (typeof body.strikePrice !== 'number' || body.strikePrice <= 0) {
      return NextResponse.json({ error: 'invalid strike' }, { status: 400 })
    }

    // Expiry must be in the past.
    const expiryMs = new Date(body.expiryIso).getTime()
    if (!isFinite(expiryMs)) {
      return NextResponse.json({ error: 'invalid expiry' }, { status: 400 })
    }
    if (expiryMs > Date.now()) {
      return NextResponse.json(
        { error: 'position not yet expired' },
        { status: 409 }
      )
    }

    if (!DISTRIBUTOR_SECRET || !LUSD_ISSUER || !LUSD_DISTRIBUTOR) {
      return NextResponse.json(
        { error: 'vault not configured' },
        { status: 500 }
      )
    }

    const server = new Horizon.Server(HORIZON)

    // Verify the original deposit exists and matches.
    const depTx = await server
      .transactions()
      .transaction(body.depositHash)
      .call()
      .catch(() => null)
    if (!depTx || depTx.source_account !== body.address) {
      return NextResponse.json({ error: 'deposit not found' }, { status: 404 })
    }
    const ops = await server.operations().forTransaction(body.depositHash).call()
    const payment = ops.records.find((o: any) => o.type === 'payment') as any
    if (!payment || payment.to !== LUSD_DISTRIBUTOR) {
      return NextResponse.json(
        { error: 'deposit does not target distributor' },
        { status: 400 }
      )
    }
    const actualAmount = parseFloat(payment.amount)
    if (Math.abs(actualAmount - body.collateralAmount) > 0.01) {
      return NextResponse.json(
        { error: 'deposit amount mismatch' },
        { status: 400 }
      )
    }

    // ---- settle: compare spot at settlement to strike
    const spot = await fetchXlmUsd()

    const distributor = Keypair.fromSecret(DISTRIBUTOR_SECRET)
    const lusd = new Asset(LUSD_CODE, LUSD_ISSUER)
    const xlm = Asset.native()

    // Decide payout direction
    //   covered call: spot <= strike → return XLM; spot > strike → pay LUSD = collat * strike
    //   put:          spot >= strike → return LUSD; spot < strike → pay XLM = collat / strike
    let payoutAsset: Asset
    let payoutAmount: number
    let outcome: 'kept' | 'assigned'
    if (body.type === 'call') {
      if (spot <= body.strikePrice) {
        payoutAsset = xlm
        payoutAmount = body.collateralAmount
        outcome = 'kept'
      } else {
        payoutAsset = lusd
        payoutAmount = body.collateralAmount * body.strikePrice
        outcome = 'assigned'
      }
    } else {
      if (spot >= body.strikePrice) {
        payoutAsset = lusd
        payoutAmount = body.collateralAmount
        outcome = 'kept'
      } else {
        payoutAsset = xlm
        payoutAmount = body.collateralAmount / body.strikePrice
        outcome = 'assigned'
      }
    }

    // Ensure recipient has trustline for LUSD if it's the payout asset
    const recipient = await server.loadAccount(body.address)
    if (payoutAsset.isNative() === false) {
      const hasTrust = recipient.balances.some(
        (b: any) =>
          b.asset_code === LUSD_CODE && b.asset_issuer === LUSD_ISSUER
      )
      if (!hasTrust) {
        return NextResponse.json(
          { error: 'recipient missing LUSD trustline' },
          { status: 409 }
        )
      }
    }

    const distAccount = await server.loadAccount(distributor.publicKey())
    const tx = new TransactionBuilder(distAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: body.address,
          asset: payoutAsset,
          amount: payoutAmount.toFixed(7),
        })
      )
      .setTimeout(60)
      .build()
    tx.sign(distributor)
    const res = await server.submitTransaction(tx as any)

    // Log claim to database
    let dbWarning: string | undefined
    try {
      await logTransaction({
        address: body.address,
        type: 'claim',
        subtype: body.type,
        amount: payoutAmount,
        asset: payoutAsset.isNative() ? 'XLM' : 'LUSD',
        txHash: (res as any).hash,
        metadata: {
          depositHash: body.depositHash,
          outcome,
          settlementSpot: spot,
          strikePrice: body.strikePrice,
        },
      })
    } catch (dbErr: any) {
      dbWarning = dbErr?.message ?? 'unknown DB error'
      console.error('Failed to log claim transaction:', dbErr)
    }

    return NextResponse.json({
      ok: true,
      outcome,
      settlementSpot: spot,
      payoutAsset: payoutAsset.isNative() ? 'XLM' : 'LUSD',
      payoutAmount: payoutAmount.toFixed(7),
      claimHash: (res as any).hash,
      ...(dbWarning ? { warning: `Leaderboard not updated: ${dbWarning}` } : {}),
    })
  } catch (e: any) {
    const extras = e?.response?.data?.extras
    return NextResponse.json(
      {
        error: 'claim failed',
        detail:
          extras?.result_codes ??
          e?.response?.data?.title ??
          e?.message ??
          'unknown',
      },
      { status: 500 }
    )
  }
}

async function fetchXlmUsd(): Promise<number> {
  const r = await fetch(
    'https://api.binance.com/api/v3/ticker/price?symbol=XLMUSDT',
    { cache: 'no-store' }
  )
  if (!r.ok) throw new Error('price feed unavailable')
  const j = await r.json()
  const n = parseFloat(j.price)
  if (!isFinite(n) || n <= 0) throw new Error('invalid price from feed')
  return n
}
