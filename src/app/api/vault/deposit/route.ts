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
import { rateLimit } from '@/lib/rate-limit'
import { isValidStellarAddress } from '@/lib/utils'
import {
  reserveAction,
  releaseAction,
  confirmAction,
} from '@/lib/idempotency'
import {
  reserveDepositCapacity,
  finalizeDeposit,
  cancelPendingDeposit,
  CapExceededError,
} from '@/lib/deposit-capacity'
import { quoteOptionLive } from '@/lib/pricing-server'
import {
  computeOpenBuckets,
  expiryDateKey,
  CALL_EPOCH_CAP_XLM,
  PUT_EPOCH_CAP_USD,
} from '@/lib/vault-state'
import { expiryUtilization } from '@/lib/expiries'
import { getBreakerState } from '@/lib/circuit-breaker'
import { LUSD_CODE, LUSD_ISSUER, LUSD_DISTRIBUTOR } from '@/lib/lusd'

const HORIZON =
  process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org'
const DISTRIBUTOR_SECRET = process.env.LUSD_DISTRIBUTOR_SECRET ?? ''
// Protocol commission wallet. The explicit fee is a slice of the upfront the
// user would receive (computed by the quote engine as `quote.protocolFee`), so
// total distributor outflow stays equal to the gross upfront — the fee is just
// redirected here instead of going to the user. If unset / no trustline, the
// fee stays in the distributor and is recorded for accounting.
const FEE_WALLET = process.env.FEE_WALLET ?? ''

// Per-wallet position cap (USD notional) — stops one user monopolizing the vault.
const MAX_USER_NOTIONAL_USD = Number(process.env.MAX_USER_NOTIONAL_USD ?? 50_000)
// Per-wallet allowance PER EXPIRY, in collateral units. Cumulative within an
// expiry (1k + 9k deposits both pass; the 10,001st unit doesn't) and resets
// with each expiry bucket — a user may fill every open epoch to this max.
const MAX_USER_EPOCH_CALL_XLM = Number(process.env.MAX_USER_EPOCH_CALL_XLM ?? 10_000)
const MAX_USER_EPOCH_PUT_USD = Number(process.env.MAX_USER_EPOCH_PUT_USD ?? 10_000)
// Per-strike inventory cap (in USD notional). Stops one strike from
// soaking up all the vault's risk budget. Without this, a whale could
// dump $200k on a single 6%-OTM weekly call and concentrate the entire
// short-call delta on one price point.
const STRIKE_INVENTORY_LIMIT_USD = Number(process.env.STRIKE_INVENTORY_LIMIT_USD ?? 30_000)
// How tightly we group strikes when computing the per-strike running total.
// Two deposits are treated as the "same strike" if their prices are within
// this fraction of each other (default 1%). Prevents trivially-different
// strike values from bypassing the cap.
const STRIKE_BUCKET_PCT = 0.01

// Hard caps to prevent runaway drips even if the verifier is fooled.
const MAX_PREMIUM_LUSD = 5000

interface DepositBody {
  address: string
  txHash: string
  type: 'call' | 'put'
  collateralAmount: number
  strikePrice: number      // required — server reprices BS from this
  daysToExpiry: number
  expiryIso?: string       // canonical settlement timestamp; derived if absent
  /** Ignored — kept for legacy clients so they don't 400. Server recomputes. */
  apr?: number
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
      typeof body.daysToExpiry !== 'number' ||
      !isFinite(body.daysToExpiry) ||
      body.daysToExpiry <= 0 ||
      body.daysToExpiry > 365
    ) {
      return NextResponse.json({ error: 'invalid daysToExpiry' }, { status: 400 })
    }
    // Mirrors expiries.ts MIN_DAYS_TO_EXPIRY — server-side floor so a client
    // bypassing the UI can't sneak in a same-day deposit and grab decay.
    const MIN_DAYS = 2
    if (body.daysToExpiry < MIN_DAYS) {
      return NextResponse.json(
        { error: `deposits closed within ${MIN_DAYS} days of expiry` },
        { status: 409 }
      )
    }
    // Strike is now required: the server reprices Black-Scholes from it,
    // so it can't be optional any more (no strike → no quote → no payout).
    if (
      typeof body.strikePrice !== 'number' ||
      !isFinite(body.strikePrice) ||
      body.strikePrice <= 0
    ) {
      return NextResponse.json({ error: 'invalid strikePrice' }, { status: 400 })
    }
    // Canonical expiry timestamp persisted with the deposit. Trust the
    // client-supplied ISO if it parses and is reasonable; otherwise derive
    // from daysToExpiry so the claim endpoint always has a definite value.
    let canonicalExpiryIso: string
    if (typeof body.expiryIso === 'string' && body.expiryIso) {
      const t = new Date(body.expiryIso).getTime()
      if (!isFinite(t) || t <= Date.now()) {
        return NextResponse.json({ error: 'invalid expiryIso' }, { status: 400 })
      }
      // Mirror the daysToExpiry <= 365 bound. Without this a client could
      // pass a far-future expiryIso (the canonical settlement date) while
      // keeping daysToExpiry innocuous, and get a multi-year option priced.
      if (t > Date.now() + 366 * 86400_000) {
        return NextResponse.json(
          { error: 'expiryIso too far in the future (max 365 days)' },
          { status: 400 }
        )
      }
      canonicalExpiryIso = new Date(t).toISOString()
    } else {
      canonicalExpiryIso = new Date(
        Date.now() + body.daysToExpiry * 86400_000
      ).toISOString()
    }
    if (!LUSD_ISSUER || !DISTRIBUTOR_SECRET) {
      return NextResponse.json(
        { error: 'vault not configured on the server' },
        { status: 500 }
      )
    }

    // ---- circuit breaker (P1-8)
    //
    // Halt new deposits when the breaker is tripped (manually by an admin, or
    // automatically by a risk trigger). Checked before any on-chain work so we
    // reject the user *before* they sign and lock collateral. Fail-closed: if
    // we can't read the breaker state we cannot prove deposits are allowed, so
    // we refuse rather than wave through.
    try {
      const breaker = await getBreakerState()
      if (breaker.tripped) {
        return NextResponse.json(
          {
            error: `deposits are paused${breaker.reason ? ` — ${breaker.reason}` : ''}. Please try again later.`,
            code: 'circuit_breaker_open',
          },
          { status: 503 }
        )
      }
    } catch (breakerErr) {
      console.error('vault/deposit: breaker check unavailable', breakerErr)
      return NextResponse.json(
        {
          error: 'deposit safety check unavailable — please retry in a few seconds',
          code: 'breaker_check_unavailable',
        },
        { status: 503 }
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

    // NOTE: the per-epoch / per-user / per-strike caps are now enforced
    // ATOMICALLY in reserveDepositCapacity() right before the premium payout
    // (single DB transaction + advisory lock). The old read-check-then-insert
    // sequence here had a TOCTOU race: N concurrent deposits all read the
    // same "existing" totals, all passed, and overshot every cap by up to N×.

    // ---- compute premium in LUSD via the single quote engine
    //
    // Server-canonical premium. Strike and daysToExpiry come from the user
    // (they're choosing the option, not its price); spot, σ (realized vol) and
    // the forward come from the server; everything else flows from
    // quoteOptionLive() — never from any APR or premium field the client might
    // supply. This is the SAME function the UI calls via /api/vault/quote, so
    // the paid premium equals the displayed premium. The previous code applied
    // a second "dynFactor" only on the server, which could diverge from the UI.
    // Fail-closed on the price feed: without spot we can neither price the
    // option nor value the deposit against the USD caps.
    let spot: number
    try {
      spot = await fetchXlmUsd()
    } catch (priceErr) {
      console.error('vault/deposit: price feed unavailable', priceErr)
      return NextResponse.json(
        {
          error: 'price feed unavailable — please retry in a few seconds',
          code: 'price_feed_unavailable',
        },
        { status: 503 }
      )
    }
    const notionalUsd =
      body.type === 'call' ? paidAmount * spot : paidAmount // LUSD ≈ $1

    // Pool utilization for this deposit's expiry — the haircut input. Computed
    // from the server's own trusted on-chain open interest, mirroring the UI.
    let utilization = 0
    try {
      const openBuckets = await computeOpenBuckets()
      const n = openBuckets.length || 1
      const aggUtil =
        body.type === 'call'
          ? openBuckets.reduce((a, b) => a + b.callXlm, 0) / (CALL_EPOCH_CAP_XLM * n)
          : openBuckets.reduce((a, b) => a + b.putUsd, 0) / (PUT_EPOCH_CAP_USD * n)
      const slot = openBuckets.findIndex(
        (b) => b.dateKey === expiryDateKey(canonicalExpiryIso)
      )
      utilization = expiryUtilization(aggUtil, slot >= 0 ? slot : 0)
    } catch (dynErr) {
      // DB was reachable moments ago (the cap/limit checks above fail-closed on
      // it), so this is unlikely. If it does fail, assume a nearly-full pool so
      // the haircut is maximal and we never overpay.
      console.warn('vault/deposit: util read failed, assuming full pool', dynErr)
      utilization = 0.98
    }

    // SECURITY: price the option on the time until the CANONICAL expiry we will
    // settle against — never the client-supplied daysToExpiry. Otherwise a
    // caller could send a long daysToExpiry (high premium) with a near-term
    // expiryIso (settles almost immediately) and harvest a long-dated premium
    // for a one-minute lock. Pricing time == settlement time, always.
    const pricingDays = Math.max(
      MIN_DAYS,
      Math.ceil((new Date(canonicalExpiryIso).getTime() - Date.now()) / 86400_000)
    )

    // THE quote. σ from XLM realized vol, forward from perp funding, haircut
    // from base + utilization. Fails closed if the σ feed is unavailable.
    const { quote, context } = await quoteOptionLive({
      side: body.type,
      spot,
      strike: body.strikePrice,
      daysToExpiry: pricingDays,
      utilization,
    })

    // Number of option units this collateral backs:
    //   call → 1 unit of XLM per XLM deposited.
    //   put  → cash secures (cash / strike) units of XLM.
    const units =
      body.type === 'call' ? paidAmount : paidAmount / body.strikePrice

    // Upfront paid to the user — already net of the explicit protocol fee (the
    // engine took the commission out of the upfront, not the collateral). The
    // fee slice is routed to FEE_WALLET below; total distributor outflow =
    // premium + fee = the gross upfront, so this is NOT the old leak (which paid
    // the full fair premium). `protocolEdgeNotional` is the implicit settlement
    // edge, recorded for analytics only.
    const premium = quote.userPremium * units
    const fee = quote.protocolFee * units
    const protocolEdgeNotional = quote.protocolEdge * units
    const effectiveApr = quote.apr

    // Observability only: log when a legacy client APR field diverges from the
    // server quote. The server never reads body.apr.
    if (
      typeof body.apr === 'number' &&
      isFinite(body.apr) &&
      Math.abs(body.apr - effectiveApr) / Math.max(effectiveApr, 1e-6) > 0.05
    ) {
      console.warn('vault/deposit: client APR diverged from server quote', {
        clientApr: body.apr,
        serverApr: effectiveApr,
        strike: body.strikePrice,
        days: body.daysToExpiry,
      })
    }

    if (!isFinite(premium) || premium <= 0) {
      return NextResponse.json({ error: 'upfront computed as zero' }, { status: 400 })
    }
    // Cap guards total distributor outflow (user upfront + protocol fee).
    const grossUpfront = premium + fee
    if (grossUpfront > MAX_PREMIUM_LUSD) {
      return NextResponse.json(
        { error: `upfront ${grossUpfront.toFixed(2)} exceeds cap ${MAX_PREMIUM_LUSD}` },
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
      // Pay the user their net upfront (already fee-deducted by the engine).
      .addOperation(
        Operation.payment({
          destination: body.address,
          asset,
          amount: premium.toFixed(7),
        })
      )

    // Route the explicit commission to FEE_WALLET (LUSD). This slice came OUT of
    // the upfront, so total outflow = premium + fee = gross upfront (no leak).
    // If FEE_WALLET is unset or lacks a LUSD trustline, the fee simply stays in
    // the distributor (still protocol-owned) and we record it for accounting.
    let feeSent = false
    let feeNote: string | undefined
    if (FEE_WALLET && fee > 0.0000001) {
      try {
        const feeAcc = await server.loadAccount(FEE_WALLET)
        const feeHasTrust = feeAcc.balances.some(
          (b: any) => b.asset_code === LUSD_CODE && b.asset_issuer === LUSD_ISSUER
        )
        if (feeHasTrust) {
          txBuilder.addOperation(
            Operation.payment({ destination: FEE_WALLET, asset, amount: fee.toFixed(7) })
          )
          feeSent = true
        } else {
          feeNote = `FEE_WALLET has no LUSD trustline — ${fee.toFixed(4)} LUSD fee kept in distributor`
        }
      } catch (feeErr: any) {
        feeNote = `FEE_WALLET load failed (${feeErr?.message ?? 'unknown'}) — fee kept in distributor`
        console.error('vault/deposit:', feeNote)
      }
    }

    // Replay guard: atomically reserve this deposit txHash before paying the
    // upfront. Same hash POSTed again → 409 instead of a second premium drip.
    // The reservation also blocks the hash from ever being consumed by
    // /api/swap (intake exclusivity — one on-chain payment, one payout). If
    // anything downstream fails we release so the user can retry.
    const reservation = await reserveAction('deposit', body.txHash)
    if (reservation.alreadyProcessed) {
      return NextResponse.json(
        {
          error:
            'this payment has already been processed (as a deposit or a swap)',
          code: 'already_processed',
        },
        { status: 409 }
      )
    }

    // Capacity reservation: per-user, per-strike and per-epoch caps are
    // checked and the position row inserted in ONE advisory-locked DB
    // transaction, so concurrent deposits can't all pass the same caps
    // (TOCTOU). The row is written BEFORE the payout, marked pending; it
    // counts toward the caps immediately and already carries everything the
    // claim endpoint needs, so a post-payout DB blip can no longer produce a
    // paid-but-untracked position.
    let pendingId: number
    try {
      pendingId = await reserveDepositCapacity({
        address: body.address,
        type: body.type,
        collateralAmount: paidAmount,
        notionalUsd,
        strikePrice: body.strikePrice,
        strikeBucketPct: STRIKE_BUCKET_PCT,
        expiryIso: canonicalExpiryIso,
        daysToExpiry: pricingDays,
        txHash: body.txHash,
        maxUserNotionalUsd: MAX_USER_NOTIONAL_USD,
        strikeInventoryLimitUsd: STRIKE_INVENTORY_LIMIT_USD,
        maxUserEpochCallXlm: MAX_USER_EPOCH_CALL_XLM,
        maxUserEpochPutUsd: MAX_USER_EPOCH_PUT_USD,
        metadata: {
          collateralAmount: paidAmount,
          strikePrice: body.strikePrice,
          apr: effectiveApr,
          daysToExpiry: pricingDays,
          expiryIso: canonicalExpiryIso,
          spot,
          forward: quote.forward,
          sigmaRealized: quote.sigmaRealized,
          sigmaOffered: quote.sigmaOffered,
          haircut: quote.haircut,
          utilization: quote.utilization,
          fairPremium: quote.fairPremium,
          protocolFee: fee,
          feeSent,
          protocolEdgeNotional,
          units,
          forwardSource: context.forwardSource,
          volMethod: context.volMethod,
        },
      })
    } catch (capErr) {
      await releaseAction('deposit', body.txHash)
      if (capErr instanceof CapExceededError) {
        return NextResponse.json(
          { error: capErr.message, code: capErr.code },
          { status: 409 }
        )
      }
      console.error('vault/deposit: capacity reservation unavailable', capErr)
      return NextResponse.json(
        {
          error:
            'deposit limit check unavailable — please retry in a few seconds',
          code: 'limit_check_unavailable',
        },
        { status: 503 }
      )
    }

    const premiumTx = txBuilder.setTimeout(60).build()
    premiumTx.sign(distributor)

    let payRes: Awaited<ReturnType<typeof server.submitTransaction>>
    try {
      payRes = await server.submitTransaction(premiumTx as any)
    } catch (submitErr) {
      await cancelPendingDeposit(pendingId)
      await releaseAction('deposit', body.txHash)
      throw submitErr
    }

    await confirmAction('deposit', body.txHash, (payRes as any).hash)

    // Mark the pending position as paid. Non-fatal on failure: the row
    // already exists with full claim metadata and counts toward the caps.
    let dbWarning: string | undefined
    try {
      await finalizeDeposit(pendingId, (payRes as any).hash, premium)
    } catch (dbErr: any) {
      dbWarning = dbErr?.message ?? 'unknown DB error'
      console.error('Failed to finalize deposit transaction:', dbErr)
    }

    return NextResponse.json({
      ok: true,
      depositHash: body.txHash,
      premiumHash: (payRes as any).hash,
      premium: premium.toFixed(4),
      feeSent,
      ...(feeNote ? { feeNote } : {}),
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
