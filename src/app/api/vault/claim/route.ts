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
import { logTransaction, getDepositRecord } from '@/lib/db-queries'
import { rateLimit } from '@/lib/rate-limit'
import { isValidStellarAddress } from '@/lib/utils'
import {
  reserveAction,
  releaseAction,
  confirmAction,
} from '@/lib/idempotency'
import { LUSD_CODE, LUSD_ISSUER, LUSD_DISTRIBUTOR } from '@/lib/lusd'

const HORIZON =
  process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org'
const DISTRIBUTOR_SECRET = process.env.LUSD_DISTRIBUTOR_SECRET ?? ''

// Server-canonical claim. The client only needs to identify *which* deposit
// to settle (address + depositHash). Every parameter that affects assignment
// math — type, strike, expiry, collateral — is read from the deposit row the
// server recorded at deposit time. Anything the client also sends in these
// fields is logged for mismatch detection but otherwise ignored.
interface ClaimBody {
  address: string
  depositHash: string
  // Optional, ignored — kept in the type so older clients don't break, and
  // so we can warn on mismatch.
  type?: 'call' | 'put'
  collateralAmount?: number
  strikePrice?: number
  expiryIso?: string
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

    if (!DISTRIBUTOR_SECRET || !LUSD_ISSUER || !LUSD_DISTRIBUTOR) {
      return NextResponse.json(
        { error: 'vault not configured' },
        { status: 500 }
      )
    }

    // ---- load the server-trusted position
    //
    // This is the single source of truth for the position. Replaces the
    // client-supplied strike / expiry / type / collateral, which an attacker
    // could otherwise tune to extract upside on an ITM position.
    const record = await getDepositRecord(body.depositHash)
    if (!record) {
      return NextResponse.json(
        { error: 'deposit record not found' },
        { status: 404 }
      )
    }
    if (record.address !== body.address) {
      return NextResponse.json(
        { error: 'deposit does not belong to this address' },
        { status: 403 }
      )
    }
    if (record.strikePrice === null || record.strikePrice <= 0) {
      return NextResponse.json(
        { error: 'deposit has no strike on record — manual review required' },
        { status: 409 }
      )
    }
    if (!record.expiryIso) {
      return NextResponse.json(
        { error: 'deposit has no expiry on record — manual review required' },
        { status: 409 }
      )
    }

    const type = record.type
    const collateralAmount = record.collateralAmount
    const strikePrice = record.strikePrice
    const expiryIso = record.expiryIso

    // Defense-in-depth: surface (don't enforce, to stay backward-compatible
    // with older clients) any mismatch between what the client thought the
    // position was and what the server knows it is. Pure observability — the
    // server still trusts only its own record.
    if (
      (body.type && body.type !== type) ||
      (typeof body.strikePrice === 'number' &&
        Math.abs(body.strikePrice - strikePrice) > 1e-6) ||
      (typeof body.collateralAmount === 'number' &&
        Math.abs(body.collateralAmount - collateralAmount) > 0.01) ||
      (body.expiryIso && body.expiryIso !== expiryIso)
    ) {
      console.warn('claim: client/server position mismatch', {
        depositHash: body.depositHash,
        client: {
          type: body.type,
          strike: body.strikePrice,
          collateral: body.collateralAmount,
          expiry: body.expiryIso,
        },
        server: { type, strike: strikePrice, collateral: collateralAmount, expiry: expiryIso },
      })
    }

    // Expiry must be in the past (per server record).
    const expiryMs = new Date(expiryIso).getTime()
    if (!isFinite(expiryMs)) {
      return NextResponse.json({ error: 'invalid expiry on record' }, { status: 500 })
    }
    if (expiryMs > Date.now()) {
      return NextResponse.json(
        { error: 'position not yet expired' },
        { status: 409 }
      )
    }

    const server = new Horizon.Server(HORIZON)

    // Verify the original deposit exists on-chain and matches the recorded
    // collateral amount. (The DB record already binds address; this guards
    // against a corrupted/forged DB row pointing at someone else's tx.)
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
    if (Math.abs(actualAmount - collateralAmount) > 0.01) {
      return NextResponse.json(
        { error: 'deposit amount mismatch with on-chain payment' },
        { status: 400 }
      )
    }

    // ---- settle against the price AT EXPIRY, not the price right now.
    //
    // SECURITY/economics: the user chooses when to claim (any time after
    // expiry). If we settled at the live price, a covered-call writer could
    // wait until spot dips below the strike and always claim "kept" (get their
    // XLM back), dodging assignment and the upside the protocol is owed — which
    // would make the vault structurally unprofitable. Pinning settlement to the
    // expiry-minute price removes all timing discretion.
    const spot = await fetchXlmUsdAt(expiryMs)

    const distributor = Keypair.fromSecret(DISTRIBUTOR_SECRET)
    const lusd = new Asset(LUSD_CODE, LUSD_ISSUER)
    const xlm = Asset.native()

    // Decide payout direction
    //   covered call: spot <= strike → return XLM; spot > strike → pay LUSD = collat * strike
    //   put:          spot >= strike → return LUSD; spot < strike → pay XLM = collat / strike
    let payoutAsset: Asset
    let payoutAmount: number
    let outcome: 'kept' | 'assigned'
    if (type === 'call') {
      if (spot <= strikePrice) {
        payoutAsset = xlm
        payoutAmount = collateralAmount
        outcome = 'kept'
      } else {
        payoutAsset = lusd
        payoutAmount = collateralAmount * strikePrice
        outcome = 'assigned'
      }
    } else {
      if (spot >= strikePrice) {
        payoutAsset = lusd
        payoutAmount = collateralAmount
        outcome = 'kept'
      } else {
        payoutAsset = xlm
        payoutAmount = collateralAmount / strikePrice
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

    // Replay guard: atomically reserve this depositHash before any payout.
    // A duplicate request — same hash, after a successful settle — hits the
    // UNIQUE constraint on processed_actions and is rejected with 409. If
    // the downstream Horizon submit fails, we release the reservation so the
    // user can retry; on success we record the payout hash for audit.
    const reservation = await reserveAction('claim', body.depositHash)
    if (reservation.alreadyProcessed) {
      return NextResponse.json(
        { error: 'deposit already claimed' },
        { status: 409 }
      )
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
    let res: Awaited<ReturnType<typeof server.submitTransaction>>
    try {
      res = await server.submitTransaction(tx as any)
    } catch (submitErr) {
      await releaseAction('claim', body.depositHash)
      throw submitErr
    }

    await confirmAction('claim', body.depositHash, (res as any).hash)

    // Log claim to database
    let dbWarning: string | undefined
    try {
      await logTransaction({
        address: body.address,
        type: 'claim',
        subtype: type,
        amount: payoutAmount,
        asset: payoutAsset.isNative() ? 'XLM' : 'LUSD',
        txHash: (res as any).hash,
        metadata: {
          depositHash: body.depositHash,
          outcome,
          settlementSpot: spot,
          strikePrice,
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

// Settlement price = XLM close at the expiry minute, independent of when the
// user actually claims. Falls back to the live price only if the historical
// candle is unavailable (e.g. claim within the same minute as expiry).
async function fetchXlmUsdAt(atMs: number): Promise<number> {
  try {
    const url =
      `https://api.binance.com/api/v3/klines?symbol=XLMUSDT&interval=1m` +
      `&startTime=${atMs}&limit=1`
    const r = await fetch(url, { cache: 'no-store' })
    if (r.ok) {
      const rows = await r.json()
      if (Array.isArray(rows) && rows[0]) {
        const close = parseFloat(rows[0][4])
        if (isFinite(close) && close > 0) return close
      }
    }
  } catch {
    /* fall through to live price */
  }
  return fetchXlmUsd()
}
