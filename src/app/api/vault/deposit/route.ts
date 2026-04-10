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
const FEE_WALLET = process.env.FEE_WALLET ?? ''
const PROTOCOL_FEE_RATE = 0.15 // 15% revenue share

// Hard caps to prevent runaway drips even if the verifier is fooled.
const MAX_PREMIUM_LUSD = 5000

interface DepositBody {
  address: string
  txHash: string
  type: 'call' | 'put'
  collateralAmount: number
  apr: number           // percent, e.g. 26.03
  daysToExpiry: number
  strikePrice?: number  // needed for points calculation
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as DepositBody

    // ---- validate input
    if (!isValidStellarAddress(body.address)) {
      return NextResponse.json({ error: 'invalid address' }, { status: 400 })
    }
    if (!body.txHash || typeof body.txHash !== 'string') {
      return NextResponse.json({ error: 'missing txHash' }, { status: 400 })
    }

    // Rate limit: 10 deposits per address per hour
    const rl = rateLimit(`deposit:${body.address}`, 3600_000, 10)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 }
      )
    }
    if (body.type !== 'call' && body.type !== 'put') {
      return NextResponse.json({ error: 'invalid type' }, { status: 400 })
    }
    if (
      typeof body.collateralAmount !== 'number' ||
      !isFinite(body.collateralAmount) ||
      body.collateralAmount <= 0
    ) {
      return NextResponse.json({ error: 'invalid amount' }, { status: 400 })
    }
    if (
      typeof body.apr !== 'number' ||
      !isFinite(body.apr) ||
      body.apr < 0 ||
      body.apr > 10_000
    ) {
      return NextResponse.json({ error: 'invalid apr' }, { status: 400 })
    }
    if (
      typeof body.daysToExpiry !== 'number' ||
      !isFinite(body.daysToExpiry) ||
      body.daysToExpiry <= 0 ||
      body.daysToExpiry > 365
    ) {
      return NextResponse.json({ error: 'invalid daysToExpiry' }, { status: 400 })
    }
    if (
      body.strikePrice !== undefined &&
      (typeof body.strikePrice !== 'number' || !isFinite(body.strikePrice) || body.strikePrice <= 0)
    ) {
      return NextResponse.json({ error: 'invalid strikePrice' }, { status: 400 })
    }
    if (!LUSD_ISSUER || !DISTRIBUTOR_SECRET) {
      return NextResponse.json(
        { error: 'vault not configured on the server' },
        { status: 500 }
      )
    }

    const server = new Horizon.Server(HORIZON)

    // ---- fetch the deposit tx from Horizon and verify it
    const tx = await server.transactions().transaction(body.txHash).call().catch(() => null)
    if (!tx) {
      return NextResponse.json(
        { error: 'deposit transaction not found on Horizon' },
        { status: 404 }
      )
    }
    if (tx.source_account !== body.address) {
      return NextResponse.json(
        { error: 'tx source does not match claimed address' },
        { status: 403 }
      )
    }

    const ops = await server.operations().forTransaction(body.txHash).call()
    const payment = ops.records.find((o: any) => o.type === 'payment') as any
    if (!payment || payment.to !== LUSD_DISTRIBUTOR) {
      return NextResponse.json(
        { error: 'tx does not pay the vault distributor' },
        { status: 400 }
      )
    }

    // Verify asset matches the vault type
    const expectedNative = body.type === 'call'
    const paidNative = payment.asset_type === 'native'
    if (expectedNative !== paidNative) {
      return NextResponse.json(
        { error: 'wrong collateral asset for this vault' },
        { status: 400 }
      )
    }
    if (
      !paidNative &&
      (payment.asset_code !== LUSD_CODE || payment.asset_issuer !== LUSD_ISSUER)
    ) {
      return NextResponse.json(
        { error: 'put vault only accepts LUSD' },
        { status: 400 }
      )
    }

    const paidAmount = parseFloat(payment.amount)
    // Allow 0.01 slack on floating point stringification
    if (Math.abs(paidAmount - body.collateralAmount) > 0.01) {
      return NextResponse.json(
        { error: `paid amount ${paidAmount} does not match claim ${body.collateralAmount}` },
        { status: 400 }
      )
    }

    // ---- compute premium in LUSD
    //
    // For covered call: collateral is XLM. We need the USD notional to
    // derive the premium. Fetch spot from Binance server-side.
    let notionalUsd: number
    if (body.type === 'call') {
      const spot = await fetchXlmUsd()
      notionalUsd = paidAmount * spot
    } else {
      notionalUsd = paidAmount // already USD (LUSD ≈ $1)
    }

    // Gross premium from the quoted APR; split into user upfront + protocol fee
    const grossPremium = notionalUsd * (body.apr / 100) * (body.daysToExpiry / 365)
    const fee = grossPremium * PROTOCOL_FEE_RATE
    const premium = grossPremium - fee // net upfront to user

    if (!isFinite(premium) || premium <= 0) {
      return NextResponse.json({ error: 'upfront computed as zero' }, { status: 400 })
    }
    if (grossPremium > MAX_PREMIUM_LUSD) {
      return NextResponse.json(
        { error: `upfront ${grossPremium.toFixed(2)} exceeds cap ${MAX_PREMIUM_LUSD}` },
        { status: 400 }
      )
    }

    // ---- pay out the upfront from the distributor
    const distributor = Keypair.fromSecret(DISTRIBUTOR_SECRET)
    const asset = new Asset(LUSD_CODE, LUSD_ISSUER)

    // Ensure recipient has a LUSD trustline
    const recipient = await server.loadAccount(body.address)
    const hasTrust = recipient.balances.some(
      (b: any) => b.asset_code === LUSD_CODE && b.asset_issuer === LUSD_ISSUER
    )
    if (!hasTrust) {
      return NextResponse.json(
        { error: 'recipient must open a LUSD trustline before depositing' },
        { status: 409 }
      )
    }

    const distAccount = await server.loadAccount(distributor.publicKey())
    const txBuilder = new TransactionBuilder(distAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      // Send net upfront to user
      .addOperation(
        Operation.payment({
          destination: body.address,
          asset,
          amount: premium.toFixed(7),
        })
      )

    // Send protocol fee to fee wallet (only if fee wallet has LUSD trustline)
    let feeSent = false
    if (FEE_WALLET && fee > 0.0000001) {
      try {
        const feeAcc = await server.loadAccount(FEE_WALLET)
        const feeHasTrust = feeAcc.balances.some(
          (b: any) => b.asset_code === LUSD_CODE && b.asset_issuer === LUSD_ISSUER
        )
        if (feeHasTrust) {
          txBuilder.addOperation(
            Operation.payment({
              destination: FEE_WALLET,
              asset,
              amount: fee.toFixed(7),
            })
          )
          feeSent = true
        }
      } catch {
        // Fee wallet not found or unreachable — fee stays in distributor
      }
    }

    const premiumTx = txBuilder.setTimeout(60).build()
    premiumTx.sign(distributor)

    const payRes = await server.submitTransaction(premiumTx as any)

    // Log transaction to database
    let dbWarning: string | undefined
    try {
      await logTransaction({
        address: body.address,
        type: 'deposit',
        subtype: body.type,
        amount: notionalUsd,
        asset: body.type === 'call' ? 'XLM' : 'LUSD',
        txHash: body.txHash,
        premiumHash: (payRes as any).hash,
        premiumAmount: premium,
        metadata: {
          collateralAmount: paidAmount,
          strikePrice: body.strikePrice ?? null,
          apr: body.apr,
          daysToExpiry: body.daysToExpiry,
        },
      })
    } catch (dbErr: any) {
      dbWarning = dbErr?.message ?? 'unknown DB error'
      console.error('Failed to log deposit transaction:', dbErr)
    }

    return NextResponse.json({
      ok: true,
      depositHash: body.txHash,
      premiumHash: (payRes as any).hash,
      premium: premium.toFixed(4),
      ...(dbWarning ? { warning: `Leaderboard not updated: ${dbWarning}` } : {}),
    })
  } catch (e: any) {
    const extras = e?.response?.data?.extras
    return NextResponse.json(
      {
        error: 'vault deposit failed',
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
