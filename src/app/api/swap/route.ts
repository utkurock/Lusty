import { NextResponse } from 'next/server'
import { errorRef } from '@/lib/api-error'
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
import { durableRateLimit } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/anti-spam'
import { isValidStellarAddress } from '@/lib/utils'
import {
  reserveAction,
  releaseAction,
  confirmAction,
  holdUnconfirmed,
  reserveSwapFlow,
  releaseSwapFlow,
  settleSwapFlow,
  swapFlowHeadroom,
} from '@/lib/idempotency'
import { submitPayout } from '@/lib/payout-submit'
import { LUSD_CODE, LUSD_ISSUER } from '@/lib/lusd'
import {
  verifyFunding,
  canonicalFundingHash,
  distributorMismatch,
  FUNDING_MAX_AGE_MS,
  type ProofOperation,
  type ProofTransaction,
} from '@/lib/swap-proof'
import { fetchXlmUsd } from '@/lib/spot'
import { reflectorPriceAt } from '@/lib/reflector'
import { getPool, ensureSchema } from '@/lib/db'
import { readJsonCapped, BodyTooLargeError } from '@/lib/request-body'

const HORIZON =
  process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org'
const DISTRIBUTOR_SECRET = process.env.LUSD_DISTRIBUTOR_SECRET ?? ''
const FEE_WALLET = process.env.FEE_WALLET ?? ''
const SPREAD = 0.001 // 0.1% spread

const num = (raw: string | undefined, fallback: number) => {
  const n = Number(raw)
  return isFinite(n) && n > 0 ? n : fallback
}

// Most XLM lusd_to_xlm pays out across everyone in a rolling day. LUSD is free
// from the faucet, so without a ceiling the reverse swap is a tap on the XLM
// every other payout's fees are paid from. See the flow ledger in
// lib/idempotency.
const XLM_OUT_DAILY_MAX = num(process.env.SWAP_XLM_OUT_DAILY_MAX, 5_000)

// XLM the distributor keeps spendable after any native payout, beyond its
// reserve. The faucet, the bridge and the swap all sign with this account, and
// one that cannot pay a fee cannot pay anybody.
const DISTRIBUTOR_XLM_FLOOR = num(process.env.SWAP_DISTRIBUTOR_XLM_FLOOR, 25)

/** Stellar's base reserve, in XLM, per entry an account holds. */
const BASE_RESERVE_XLM = 0.5

/**
 * The native XLM an account can actually send: its balance less the minimum
 * reserve its entries lock up and whatever its open offers have promised.
 */
function spendableNative(account: Horizon.AccountResponse): number {
  const a = account as any
  const native = account.balances.find((b: any) => b.asset_type === 'native') as any
  const entries =
    2 +
    Number(a.subentry_count ?? 0) +
    Number(a.num_sponsoring ?? 0) -
    Number(a.num_sponsored ?? 0)
  return (
    parseFloat(native?.balance ?? '0') -
    entries * BASE_RESERVE_XLM -
    parseFloat(native?.selling_liabilities ?? '0')
  )
}

/** Why the swap cannot pay out on this deployment, or null when it can. */
function misconfigured(): string | null {
  if (!LUSD_ISSUER || !DISTRIBUTOR_SECRET) return 'swap is not configured on the server'
  return distributorMismatch(DISTRIBUTOR_SECRET)
}

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
  // Every preflight costs a database round trip, an oracle read and a Horizon
  // account load, and asks for nothing in return. Bounded per client so one
  // caller cannot spend those on everyone's behalf.
  const rl = await durableRateLimit(`swap-preflight:ip:${getClientIp(req) ?? 'anon'}`, 60_000, 30)
  if (!rl.ok) {
    return NextResponse.json(
      { ready: false, reason: `rate limited — retry after ${rl.retryAfter}s` },
      { status: 429 }
    )
  }

  const url = new URL(req.url)
  const direction = url.searchParams.get('direction')
  const amount = Number(url.searchParams.get('amount') ?? '0')
  // Optional: who will pay. Only lusd_to_xlm reads it, to say before the
  // payment whether this address has the XLM credit the payout will need.
  const address = url.searchParams.get('address')

  if (direction !== 'xlm_to_lusd' && direction !== 'lusd_to_xlm') {
    return NextResponse.json({ error: 'invalid direction' }, { status: 400 })
  }
  if (!isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: 'invalid amount' }, { status: 400 })
  }
  if (address !== null && !isValidStellarAddress(address)) {
    return NextResponse.json({ error: 'invalid address' }, { status: 400 })
  }
  const missing = misconfigured()
  if (missing) {
    return NextResponse.json({ ready: false, reason: missing }, { status: 503 })
  }

  try {
    // 1. Is the database reachable? The payout path reserves the funding hash
    // against replay before it submits, and that reservation is a write. A
    // database that cannot be reached therefore stops the swap — after the
    // payment has landed. This preflight checked the price and the balance and
    // not this, which is how a third 10 XLM was taken tonight while the pooler's
    // TLS was misconfigured. Anything the payout needs belongs in front of it.
    await ensureSchema()
    await getPool().query('select 1')

    // 2. Can we price it?
    const spot = await fetchXlmUsd()
    const gross = direction === 'xlm_to_lusd' ? amount * spot : amount / spot
    const destAmount = gross * (1 - SPREAD)

    // 3. Can the distributor cover the payout?
    const server = new Horizon.Server(HORIZON)
    const dist = await server.loadAccount(
      Keypair.fromSecret(DISTRIBUTOR_SECRET).publicKey()
    )
    const held = dist.balances.find(
      (b: any) => b.asset_code === LUSD_CODE && b.asset_issuer === LUSD_ISSUER
    )
    // Native balances carry a reserve that cannot be spent, and the floor
    // keeps the fees of every other payout covered — the same rule POST
    // applies before it signs.
    const spendable =
      direction === 'xlm_to_lusd'
        ? held ? parseFloat((held as any).balance) : 0
        : spendableNative(dist) - DISTRIBUTOR_XLM_FLOOR
    if (spendable < destAmount) {
      return NextResponse.json(
        {
          ready: false,
          reason: `the protocol cannot cover this swap right now (needs ${destAmount.toFixed(4)}, has ${Math.max(0, spendable).toFixed(4)})`,
        },
        { status: 503 }
      )
    }

    // 4. Would the flow ledger let this address take that much XLM out?
    if (direction === 'lusd_to_xlm' && address) {
      const room = await swapFlowHeadroom(address, XLM_OUT_DAILY_MAX)
      if (destAmount > room.credit) {
        return NextResponse.json(
          {
            ready: false,
            reason: `this address can swap back at most ${Math.max(0, room.credit).toFixed(4)} XLM — what it has swapped in, less what it has taken out`,
            code: 'no_xlm_credit',
          },
          { status: 409 }
        )
      }
      if (destAmount > room.remaining) {
        return NextResponse.json(
          { ready: false, reason: 'the daily XLM swap allowance is used up — try again tomorrow', code: 'xlm_daily_cap' },
          { status: 503 }
        )
      }
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
        reason: `pricing is unavailable right now (${errorRef('swap preflight', e)})`,
      },
      { status: 503 }
    )
  }
}

export async function POST(req: Request) {
  // Hoisted so the catch below can name the funding transaction it failed on.
  let bodyHashForLog: string | undefined
  try {
    let body: SwapBody | null
    try {
      body = await readJsonCapped<SwapBody>(req)
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        return NextResponse.json({ error: 'request body too large' }, { status: 413 })
      }
      throw e
    }
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 })
    }

    if (!isValidStellarAddress(body.address)) {
      return NextResponse.json({ error: 'invalid address' }, { status: 400 })
    }
    // The one spelling of the funding hash every step below uses: Horizon is
    // asked for it, the replay guard is keyed on it, the log names it. See
    // canonicalFundingHash for what the other spellings used to buy.
    const txHash = canonicalFundingHash(body.txHash)
    if (!txHash) {
      return NextResponse.json(
        { error: 'txHash must be a 64-character hex transaction hash', code: 'invalid_tx_hash' },
        { status: 400 }
      )
    }
    bodyHashForLog = txHash

    // Rate limit: 10 swaps per address per hour
    const rl = await durableRateLimit(`swap:${body.address}`, 3600_000, 10)
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
    const missing = misconfigured()
    if (missing) {
      return NextResponse.json({ error: missing }, { status: 500 })
    }

    const server = new Horizon.Server(HORIZON)

    // Verify the user's payment tx on Horizon.
    //
    // What counts as proof lives in lib/swap-proof, not here: it is the only
    // thing between the distributor's balances and anybody with a hash, and a
    // rule that decides that belongs somewhere a test can reach it.
    const fetched = await server
      .transactions()
      .transaction(txHash)
      .call()
      .catch(() => null)
    // The record has to be the transaction asked for, by its own hash — not
    // whatever a path the hash was spliced into happened to resolve to.
    const tx = fetched && (fetched as ProofTransaction).hash === txHash ? fetched : null
    const operations = tx
      ? (await server.operations().forTransaction(txHash).call()).records
      : []

    const proof = verifyFunding({
      tx: tx as ProofTransaction | null,
      operations: operations as ProofOperation[],
      direction: body.direction,
      address: body.address,
      sourceAmount: body.sourceAmount,
      maxAgeMs: FUNDING_MAX_AGE_MS,
    })
    if (!('ok' in proof)) {
      return NextResponse.json(
        { error: proof.error, code: proof.code },
        { status: proof.status }
      )
    }
    // Sized from the ledger's number, never from the caller's.
    const paidAmount = proof.paidAmount

    // Price at whichever of the funding-time and the claim-time rate is worse
    // for the caller. Priced at claim time alone, the fifteen minutes a payment
    // may wait were a free option: pay, watch the feed, claim once it moved
    // your way. Taking the worse of the two leaves nothing to wait for.
    //
    // The funding-time price is the oracle's record for the period the payment
    // closed in. When that period has not been published yet — a payment
    // claimed within the same five minutes — the live price stands in, which
    // is then the same moment. A live record that predates the funding is not
    // refused: Reflector publishes on a five-minute grid, so that is the
    // ordinary case, not a stale one.
    const fundedAtMs = Date.parse((tx as ProofTransaction).created_at ?? '')
    const liveSpot = await fetchXlmUsd()
    const fundingSpot =
      (await reflectorPriceAt(fundedAtMs).catch(() => null)) ?? liveSpot
    const spot =
      body.direction === 'xlm_to_lusd'
        ? Math.min(fundingSpot, liveSpot)
        : Math.max(fundingSpot, liveSpot)
    const grossDest =
      body.direction === 'xlm_to_lusd' ? paidAmount * spot : paidAmount / spot
    // Never more than the caller was shown. A price that moved their way since
    // the quote is not theirs to collect.
    const destAmount = Math.min(grossDest * (1 - SPREAD), body.expectedDestAmount)
    // The fee is the spread on what is actually paid out. Taken from the
    // uncapped gross, a capped payout sent the fee wallet a cut of an amount
    // nobody received.
    const swapFee = (destAmount * SPREAD) / (1 - SPREAD)

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
    let feeXlm = 0
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
            feeXlm = feeInXlm
            feeNote = `paid ${feeInXlm.toFixed(4)} XLM (no LUSD trustline on fee wallet)`
          }
        }
        if (!feeSent) {
          feeNote = `FEE_WALLET ${FEE_WALLET} has no LUSD trustline — fee of ${feeInLusd.toFixed(4)} LUSD NOT sent.`
          console.error('swap:', feeNote)
        }
      } catch (feeErr: any) {
        feeNote = `fee wallet unavailable (${errorRef('swap: fee wallet', feeErr)})`
        console.error('swap:', feeNote)
      }
    }

    // A native payout must leave the distributor able to sign everything
    // else. Checked against the account this payout is built from, so it is
    // the same balance the network will debit.
    if (payoutAsset.isNative()) {
      const nativeOut = destAmount + feeXlm
      if (spendableNative(distAccount) - nativeOut < DISTRIBUTOR_XLM_FLOOR) {
        return NextResponse.json(
          {
            error: 'the protocol cannot cover this swap right now — contact support to have your payment returned',
            code: 'distributor_low',
          },
          { status: 503 }
        )
      }
    }

    const alreadyProcessed = () =>
      NextResponse.json(
        {
          error:
            'this payment has already been processed (as a swap or a deposit)',
          code: 'already_processed',
        },
        { status: 409 }
      )

    // Net-flow bound: reserve this swap's XLM in or out before anything is
    // signed. See the flow ledger in lib/idempotency for why it cannot be read
    // from the swap rows written after the payout.
    const flow = await reserveSwapFlow({
      fundingHash: txHash,
      address: body.address,
      direction: body.direction,
      xlmIn: body.direction === 'xlm_to_lusd' ? paidAmount : 0,
      xlmOut: body.direction === 'lusd_to_xlm' ? destAmount : 0,
      dailyMaxOut: XLM_OUT_DAILY_MAX,
    })
    if (!flow.ok) {
      if (flow.code === 'already_processed') return alreadyProcessed()
      if (flow.code === 'no_xlm_credit') {
        return NextResponse.json(
          {
            error: `this address can swap back at most ${flow.credit.toFixed(4)} XLM — what it has swapped in, less what it has taken out. Contact support to have your payment returned.`,
            code: 'no_xlm_credit',
          },
          { status: 409 }
        )
      }
      return NextResponse.json(
        {
          error: 'the daily XLM swap allowance is used up — contact support to have your payment returned',
          code: 'xlm_daily_cap',
        },
        { status: 503 }
      )
    }

    // Replay guard: atomically reserve the user's source txHash before the
    // distributor payout. Same source hash submitted twice → 409, and a hash
    // already consumed as a vault DEPOSIT is also rejected (intake
    // exclusivity — one on-chain payment funds a deposit or a swap, never
    // both). If Horizon submit fails, release so the user can retry; on
    // success record the payout hash for audit. The flow row reserved above
    // follows the same fate, so a refusal here gives its room back.
    let reservation: Awaited<ReturnType<typeof reserveAction>>
    try {
      reservation = await reserveAction('swap', txHash)
    } catch (e) {
      await releaseSwapFlow(txHash)
      throw e
    }
    if (reservation.alreadyProcessed) {
      await releaseSwapFlow(txHash)
      return alreadyProcessed()
    }

    const payoutTx = txBuilder.setTimeout(60).build()
    payoutTx.sign(distributor)

    // The guard is released only when the network refused the payout. On a
    // timeout the payout may still land, and a released guard would pay this
    // funding hash again — see lib/payout-submit.
    const submission = await submitPayout(
      () => server.submitTransaction(payoutTx as any) as Promise<{ hash: string }>,
      payoutTx.hash().toString('hex')
    )
    if (submission.kind === 'rejected') {
      await releaseAction('swap', txHash)
      await releaseSwapFlow(txHash)
      throw submission.error
    }
    if (submission.kind === 'unknown') {
      // The flow row stays pending: the payout may have landed, so its XLM
      // keeps counting against the address's credit and the daily ceiling.
      await holdUnconfirmed('swap', txHash, submission.hash)
      console.error(
        `swap: payout ${submission.hash} for funding tx ${txHash} is unconfirmed; guard kept. Reason:`,
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
    const payRes = { hash: submission.hash }

    await confirmAction('swap', txHash, payRes.hash)
    await settleSwapFlow(txHash)

    // Log swap to database
    let dbWarning: string | undefined
    try {
      await logTransaction({
        address: body.address,
        type: 'deposit',
        subtype: 'swap',
        amount: body.direction === 'xlm_to_lusd' ? paidAmount * spot : paidAmount,
        asset: body.direction === 'xlm_to_lusd' ? 'XLM' : 'LUSD',
        txHash,
        premiumHash: payRes.hash,
        metadata: {
          direction: body.direction,
          sourceAmount: paidAmount,
          destAmount,
          spot,
          spotLive: liveSpot,
          spotAtFunding: fundingSpot,
        },
      })
    } catch (dbErr: any) {
      dbWarning = errorRef('swap: not logged', dbErr)
      console.error('Failed to log swap transaction:', dbErr)
    }

    return NextResponse.json({
      ok: true,
      sourceAmount: paidAmount.toFixed(7),
      destAmount: destAmount.toFixed(7),
      payoutHash: payRes.hash,
      spot,
      feeSent,
      ...(feeNote ? { feeNote } : {}),
      ...(dbWarning ? { warning: `Leaderboard not updated: ${dbWarning}` } : {}),
    })
  } catch (e: any) {
    const extras = e?.response?.data?.extras
    const detail =
      extras?.result_codes ?? e?.response?.data?.title ?? errorRef('swap', e)
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

