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
import {
  reserveAction,
  releaseAction,
  confirmAction,
} from '@/lib/idempotency'
import { LUSD_CODE, LUSD_ISSUER, LUSD_DISTRIBUTOR } from '@/lib/lusd'
import { fetchXlmUsd } from '@/lib/spot'

const HORIZON =
  process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org'
const DISTRIBUTOR_SECRET = process.env.LUSD_DISTRIBUTOR_SECRET ?? ''
const FEE_WALLET = process.env.FEE_WALLET ?? ''

interface SwapBody {
  address: string
  txHash: string
  direction: 'xlm_to_lusd' | 'lusd_to_xlm'
  sourceAmount: number
  expectedDestAmount: number
}

/**
 * Can a swap be paid out right now?
 *
 * The order this route is called in used to be: the user signs a payment to the
 * distributor, the payment lands irreversibly, and only then does the server
 * find out whether it can price the swap and cover the payout. Everything that
 * could fail — a price feed, a balance, a missing key — failed after the money
 * had already moved, and the user was told "swap failed" while their funds sat
 * at the distributor with no record of what they were owed.
 *
 * So the checks move in front of the payment. This answers the only question
 * worth asking before signing: if I send this, will it come back?
 *
 * It is a readiness check, not a promise — the price is refetched at payout and
 * a balance can change in between. It closes the window; it cannot remove it.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const direction = url.searchParams.get('direction')
  const amount = Number(url.searchParams.get('amount') ?? '0')

  if (direction !== 'xlm_to_lusd' && direction !== 'lusd_to_xlm') {
    return NextResponse.json({ error: 'invalid direction' }, { status: 400 })
  }
  if (!isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: 'invalid amount' }, { status: 400 })
  }
  if (!LUSD_ISSUER || !DISTRIBUTOR_SECRET) {
    return NextResponse.json(
      { ready: false, reason: 'swap is not configured on the server' },
      { status: 503 }
    )
  }

  try {
    // 1. Can we price it? This is the check that was failing after the fact.
    const spot = await fetchXlmUsd()
    const gross = direction === 'xlm_to_lusd' ? amount * spot : amount / spot
    const destAmount = gross * (1 - 0.001)

    // 2. Can the distributor cover the payout?
    const server = new Horizon.Server(HORIZON)
    const dist = await server.loadAccount(
      Keypair.fromSecret(DISTRIBUTOR_SECRET).publicKey()
    )
    const held =
      direction === 'xlm_to_lusd'
        ? dist.balances.find(
            (b: any) => b.asset_code === LUSD_CODE && b.asset_issuer === LUSD_ISSUER
          )
        : dist.balances.find((b: any) => b.asset_type === 'native')
    const available = held ? parseFloat((held as any).balance) : 0
    // Native balances carry a base reserve that cannot be spent; keep clear of it.
    const spendable = direction === 'lusd_to_xlm' ? available - 5 : available
    if (spendable < destAmount) {
      return NextResponse.json(
        {
          ready: false,
          reason: `the protocol cannot cover this swap right now (needs ${destAmount.toFixed(4)}, has ${Math.max(0, spendable).toFixed(4)})`,
        },
        { status: 503 }
      )
    }

    return NextResponse.json(
      { ready: true, spot, destAmount },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (e: any) {
    console.error('swap preflight failed:', e?.message ?? e)
    return NextResponse.json(
      {
        ready: false,
        reason: `pricing is unavailable right now — ${e?.message ?? 'unknown'}`,
      },
      { status: 503 }
    )
  }
}

export async function POST(req: Request) {
  // Hoisted so the catch below can name the funding transaction it failed on.
  let bodyHashForLog: string | undefined
  try {
    const body = (await req.json()) as SwapBody
    bodyHashForLog = typeof body?.txHash === 'string' ? body.txHash : undefined

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

    // Replay guard: atomically reserve the user's source txHash before the
    // distributor payout. Same source hash submitted twice → 409, and a hash
    // already consumed as a vault DEPOSIT is also rejected (intake
    // exclusivity — one on-chain payment funds a deposit or a swap, never
    // both). If Horizon submit fails, release so the user can retry; on
    // success record the payout hash for audit.
    const reservation = await reserveAction('swap', body.txHash)
    if (reservation.alreadyProcessed) {
      return NextResponse.json(
        {
          error:
            'this payment has already been processed (as a swap or a deposit)',
          code: 'already_processed',
        },
        { status: 409 }
      )
    }

    const payoutTx = txBuilder.setTimeout(60).build()
    payoutTx.sign(distributor)

    let payRes: Awaited<ReturnType<typeof server.submitTransaction>>
    try {
      payRes = await server.submitTransaction(payoutTx as any)
    } catch (submitErr) {
      await releaseAction('swap', body.txHash)
      throw submitErr
    }

    await confirmAction('swap', body.txHash, (payRes as any).hash)

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
    const detail =
      extras?.result_codes ?? e?.response?.data?.title ?? e?.message ?? 'unknown'
    // A swap that gets this far has already taken the user's payment: the
    // funding transaction is on the ledger and the payout is not. Returning the
    // reason to the browser and keeping none of it server-side left those
    // intakes with no trace at all — no row, no log, nothing that could later
    // say whom the protocol owes. Log the funding hash with the reason.
    console.error(
      `swap: FAILED AFTER INTAKE — funding tx ${bodyHashForLog ?? 'unknown'} is on the ledger and the payout is not. Reason:`,
      detail
    )
    return NextResponse.json({ error: 'swap failed', detail }, { status: 500 })
  }
}

