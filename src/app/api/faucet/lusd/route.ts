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

const HORIZON = process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org'
const LUSD_CODE = process.env.NEXT_PUBLIC_LUSD_CODE ?? 'LUSD'
const LUSD_ISSUER = process.env.NEXT_PUBLIC_LUSD_ISSUER ?? ''
const DISTRIBUTOR_SECRET = process.env.LUSD_DISTRIBUTOR_SECRET ?? ''

const AMOUNT = '1000' // 1,000 LUSD per drip

export async function POST(req: Request) {
  try {
    const { address } = await req.json()
    if (!isValidStellarAddress(address)) {
      return NextResponse.json({ error: 'invalid address' }, { status: 400 })
    }

    // Rate limit: 3 faucet drips per address per hour
    const rl = rateLimit(`faucet:${address}`, 3600_000, 3)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 }
      )
    }
    if (!LUSD_ISSUER || !DISTRIBUTOR_SECRET) {
      return NextResponse.json(
        { error: 'LUSD faucet not configured on the server' },
        { status: 500 }
      )
    }

    const server = new Horizon.Server(HORIZON)
    const distributor = Keypair.fromSecret(DISTRIBUTOR_SECRET)
    const asset = new Asset(LUSD_CODE, LUSD_ISSUER)

    // Verify recipient has a trustline — otherwise the payment will fail.
    const recipient = await server.loadAccount(address).catch(() => null)
    if (!recipient) {
      return NextResponse.json(
        { error: 'recipient account not found — fund with XLM first' },
        { status: 400 }
      )
    }
    const hasTrust = recipient.balances.some(
      (b: any) => b.asset_code === LUSD_CODE && b.asset_issuer === LUSD_ISSUER
    )
    if (!hasTrust) {
      return NextResponse.json(
        { error: 'open a LUSD trustline first' },
        { status: 409 }
      )
    }

    const distAccount = await server.loadAccount(distributor.publicKey())
    const tx = new TransactionBuilder(distAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({ destination: address, asset, amount: AMOUNT })
      )
      .setTimeout(60)
      .build()
    tx.sign(distributor)

    const res = await server.submitTransaction(tx as any)

    // Log faucet drip to database
    let dbWarning: string | undefined
    try {
      await logTransaction({
        address,
        type: 'faucet',
        amount: parseFloat(AMOUNT),
        asset: 'LUSD',
        txHash: (res as any).hash,
      })
    } catch (dbErr: any) {
      dbWarning = dbErr?.message ?? 'unknown DB error'
      console.error('Failed to log faucet transaction:', dbErr)
    }

    return NextResponse.json({
      ok: true,
      hash: (res as any).hash,
      amount: AMOUNT,
      ...(dbWarning ? { warning: `Leaderboard not updated: ${dbWarning}` } : {}),
    })
  } catch (e: any) {
    const extras = e?.response?.data?.extras
    return NextResponse.json(
      {
        error: 'faucet failed',
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
