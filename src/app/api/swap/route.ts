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

interface SwapBody {
  address: string
  txHash: string
  direction: 'xlm_to_lusd' | 'lusd_to_xlm'
  sourceAmount: number
  expectedDestAmount: number
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as SwapBody

    if (!isValidStellarAddress(body.address)) {
      return NextResponse.json({ error: 'invalid address' }, { status: 400 })
    }
    if (!body.txHash || typeof body.txHash !== 'string') {
      return NextResponse.json({ error: 'missing txHash' }, { status: 400 })
    }

    // Rate limit: 10 swaps per address per hour
    const rl = rateLimit(`swap:${body.address}`, 3600_000, 10)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 }
      )
    }
    if (body.direction !== 'xlm_to_lusd' && body.direction !== 'lusd_to_xlm') {
      return NextResponse.json({ error: 'invalid direction' }, { status: 400 })
    }
    if (typeof body.sourceAmount !== 'number' || body.sourceAmount <= 0) {
      return NextResponse.json({ error: 'invalid sourceAmount' }, { status: 400 })
    }
    if (typeof body.expectedDestAmount !== 'number' || body.expectedDestAmount <= 0) {
      return NextResponse.json({ error: 'invalid expectedDestAmount' }, { status: 400 })
    }
    if (!LUSD_ISSUER || !DISTRIBUTOR_SECRET) {
      return NextResponse.json(
        { error: 'swap not configured on the server' },
        { status: 500 }
      )
    }

    const server = new Horizon.Server(HORIZON)

    // Verify the user's payment tx on Horizon
    const tx = await server
      .transactions()
      .transaction(body.txHash)
      .call()
      .catch(() => null)
    if (!tx) {
      return NextResponse.json(
        { error: 'payment transaction not found on Horizon' },
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
        { error: 'tx does not pay the distributor' },
        { status: 400 }
      )
    }

    // Verify the correct asset was sent
    const paidNative = payment.asset_type === 'native'
    if (body.direction === 'xlm_to_lusd' && !paidNative) {
      return NextResponse.json(
        { error: 'expected XLM payment for xlm_to_lusd swap' },
        { status: 400 }
      )
    }
    if (body.direction === 'lusd_to_xlm' && paidNative) {
      return NextResponse.json(
        { error: 'expected LUSD payment for lusd_to_xlm swap' },
        { status: 400 }
      )
    }

    const paidAmount = parseFloat(payment.amount)
    if (Math.abs(paidAmount - body.sourceAmount) > 0.01) {
      return NextResponse.json(
        { error: `paid amount ${paidAmount} does not match claim ${body.sourceAmount}` },
        { status: 400 }
      )
    }

    // Compute the output amount using live Binance price
    const spot = await fetchXlmUsd()
    const spread = 0.001 // 0.1% spread
    let grossDest: number
    if (body.direction === 'xlm_to_lusd') {
      grossDest = paidAmount * spot
    } else {
      grossDest = paidAmount / spot
    }
    const swapFee = grossDest * spread
    const destAmount = grossDest - swapFee

    // Ensure the recipient has the necessary trustline
    const recipient = await server.loadAccount(body.address)
    if (body.direction === 'xlm_to_lusd') {
      const hasTrust = recipient.balances.some(
        (b: any) => b.asset_code === LUSD_CODE && b.asset_issuer === LUSD_ISSUER
      )
      if (!hasTrust) {
        return NextResponse.json(
          { error: 'recipient must open a LUSD trustline first' },
          { status: 409 }
        )
      }
    }

    // Send the output asset from the distributor to the user
    const distributor = Keypair.fromSecret(DISTRIBUTOR_SECRET)
    const lusd = new Asset(LUSD_CODE, LUSD_ISSUER)
    const payoutAsset = body.direction === 'xlm_to_lusd' ? lusd : Asset.native()
    // Fee is always in LUSD for accounting simplicity
    const feeAsset = lusd
    const feeInLusd = body.direction === 'xlm_to_lusd'
      ? swapFee                      // already LUSD
      : swapFee * spot               // convert XLM fee to LUSD

    const distAccount = await server.loadAccount(distributor.publicKey())
    const txBuilder = new TransactionBuilder(distAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: body.address,
          asset: payoutAsset,
          amount: destAmount.toFixed(7),
        })
      )

    // Send swap fee to fee wallet.
    //   1) Preferred: LUSD if the fee wallet has a LUSD trustline.
    //   2) Fallback: XLM equivalent (no trustline needed for native).
    //   3) Otherwise: skip and log loudly.
    let feeSent = false
    let feeNote: string | undefined
    if (FEE_WALLET && feeInLusd > 0.0000001) {
      try {
        const feeAcc = await server.loadAccount(FEE_WALLET)
        const feeHasTrust = feeAcc.balances.some(
          (b: any) => b.asset_code === LUSD_CODE && b.asset_issuer === LUSD_ISSUER
        )
        if (feeHasTrust) {
          txBuilder.addOperation(
            Operation.payment({
              destination: FEE_WALLET,
              asset: feeAsset,
              amount: feeInLusd.toFixed(7),
            })
          )
          feeSent = true
        } else {
          // Pay equivalent in XLM — works without a trustline.
          const feeInXlm = feeInLusd / spot
          if (feeInXlm > 0.0000001) {
            txBuilder.addOperation(
              Operation.payment({
                destination: FEE_WALLET,
                asset: Asset.native(),
                amount: feeInXlm.toFixed(7),
              })
            )
            feeSent = true
            feeNote = `paid ${feeInXlm.toFixed(4)} XLM (no LUSD trustline on fee wallet)`
          }
        }
        if (!feeSent) {
          feeNote = `FEE_WALLET ${FEE_WALLET} has no LUSD trustline — fee of ${feeInLusd.toFixed(4)} LUSD NOT sent.`
          console.error('swap:', feeNote)
        }
      } catch (feeErr: any) {
        feeNote = `FEE_WALLET load failed: ${feeErr?.message ?? 'unknown'}`
        console.error('swap:', feeNote)
      }
    }

    const payoutTx = txBuilder.setTimeout(60).build()
    payoutTx.sign(distributor)

    const payRes = await server.submitTransaction(payoutTx as any)

    // Log swap to database
    let dbWarning: string | undefined
    try {
      await logTransaction({
        address: body.address,
        type: 'deposit',
        subtype: 'swap',
        amount: body.direction === 'xlm_to_lusd' ? paidAmount * spot : paidAmount,
        asset: body.direction === 'xlm_to_lusd' ? 'XLM' : 'LUSD',
        txHash: body.txHash,
        premiumHash: (payRes as any).hash,
        metadata: {
          direction: body.direction,
          sourceAmount: paidAmount,
          destAmount,
          spot,
        },
      })
    } catch (dbErr: any) {
      dbWarning = dbErr?.message ?? 'unknown DB error'
      console.error('Failed to log swap transaction:', dbErr)
    }

    return NextResponse.json({
      ok: true,
      sourceAmount: paidAmount.toFixed(7),
      destAmount: destAmount.toFixed(7),
      payoutHash: (payRes as any).hash,
      spot,
      feeSent,
      ...(feeNote ? { feeNote } : {}),
      ...(dbWarning ? { warning: `Leaderboard not updated: ${dbWarning}` } : {}),
    })
  } catch (e: any) {
    const extras = e?.response?.data?.extras
    return NextResponse.json(
      {
        error: 'swap failed',
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
