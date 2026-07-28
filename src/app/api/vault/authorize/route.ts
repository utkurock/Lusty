import { NextResponse } from 'next/server'
import { Keypair, authorizeEntry, xdr } from '@stellar/stellar-sdk'
import { rateLimit } from '@/lib/rate-limit'
import { isValidStellarAddress } from '@/lib/utils'
import { credentialAddress, describeMismatch } from '@/lib/vault-auth'
import { quoteOptionLive } from '@/lib/pricing-server'
import { fetchXlmUsd } from '@/lib/spot'
import { expiryUtilizationFor } from '@/lib/vault-state'
import { assertQuoteAllowed, PolicyRejection } from '@/lib/quote-policy'
import { getBreakerState } from '@/lib/circuit-breaker'
import {
  VAULT_ID,
  NETWORK_PASSPHRASE,
  openArgs,
  vaultServer,
  coveredUnits,
  type OptionSide,
} from '@/lib/vault-contract'

export const dynamic = 'force-dynamic'

// The quoter co-signature — the protocol's half of the RFQ.
// ========================================================
// The vault contract requires auth from BOTH the writer and the quoter before
// it will escrow collateral and pay a premium, so neither side can set the
// price alone. This endpoint is the quoter: it re-derives the premium from the
// server's own pricing engine and signs the contract's authorization entry
// only if the transaction the caller actually built matches.
//
// What it cannot do is the point. It signs one authorization entry for one
// invocation of `open`. It holds no collateral, cannot move a position, and
// cannot settle. A caller who lies about the premium gets a refusal; a caller
// who sends a well-formed quote request but a different transaction underneath
// gets the same, because the entry itself is checked argument by argument.

const QUOTER_SECRET = process.env.VAULT_QUOTER_SECRET ?? ''

// How long a co-signature stays usable. Long enough for a wallet prompt,
// short enough that an unused signature expires rather than lingering.
const SIGNATURE_LEDGERS = 100 // ≈ 8 minutes at 5s ledgers

// The premium a caller may request, relative to the engine's own quote. Equal
// is the norm; the tolerance only absorbs the float rounding between the
// quote the UI rendered and the stroops it encoded.
const PREMIUM_TOLERANCE = 1e-6

const MIN_DAYS_TO_EXPIRY = 2
const MAX_DAYS_TO_EXPIRY = 365

// Concentration policy. The contract's own caps bound vault risk; these bound
// how much of it any one wallet or strike carries, and are enforced by
// declining to sign rather than by holding anything.
const MAX_USER_NOTIONAL_USD = Number(process.env.MAX_USER_NOTIONAL_USD ?? 50_000)
const MAX_USER_EPOCH_CALL_XLM = Number(process.env.MAX_USER_EPOCH_CALL_XLM ?? 10_000)
const MAX_USER_EPOCH_PUT_USD = Number(process.env.MAX_USER_EPOCH_PUT_USD ?? 10_000)
const STRIKE_INVENTORY_LIMIT_USD = Number(process.env.STRIKE_INVENTORY_LIMIT_USD ?? 30_000)
// Two deposits count against the same strike when their prices are within this
// fraction of each other, so trivially-different strikes can't bypass the cap.
const STRIKE_BUCKET_PCT = 0.01

interface AuthorizeBody {
  address: string
  side: OptionSide
  collateralAmount: number
  strikePrice: number
  expiryIso: string
  /** The premium encoded in the transaction, in cash units. */
  premium: number
  /** Base64 auth entries from simulating the `open` invocation. */
  authEntries: string[]
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as AuthorizeBody

    if (!QUOTER_SECRET) {
      return NextResponse.json(
        { error: 'quoter key not configured on the server' },
        { status: 500 },
      )
    }
    if (!VAULT_ID) {
      return NextResponse.json(
        { error: 'vault contract not configured on the server' },
        { status: 500 },
      )
    }
    if (!isValidStellarAddress(body.address)) {
      return NextResponse.json({ error: 'invalid address' }, { status: 400 })
    }
    if (body.side !== 'call' && body.side !== 'put') {
      return NextResponse.json({ error: 'invalid side' }, { status: 400 })
    }
    if (!Array.isArray(body.authEntries) || body.authEntries.length === 0) {
      return NextResponse.json({ error: 'missing authEntries' }, { status: 400 })
    }
    if (!positive(body.collateralAmount)) {
      return NextResponse.json({ error: 'invalid collateralAmount' }, { status: 400 })
    }
    if (!positive(body.strikePrice)) {
      return NextResponse.json({ error: 'invalid strikePrice' }, { status: 400 })
    }
    if (typeof body.premium !== 'number' || !isFinite(body.premium) || body.premium < 0) {
      return NextResponse.json({ error: 'invalid premium' }, { status: 400 })
    }

    const expiryMs = new Date(body.expiryIso).getTime()
    if (!isFinite(expiryMs) || expiryMs <= Date.now()) {
      return NextResponse.json({ error: 'invalid expiryIso' }, { status: 400 })
    }
    const daysToExpiry = (expiryMs - Date.now()) / 86400_000
    if (daysToExpiry < MIN_DAYS_TO_EXPIRY) {
      return NextResponse.json(
        { error: `quotes close within ${MIN_DAYS_TO_EXPIRY} days of expiry` },
        { status: 409 },
      )
    }
    if (daysToExpiry > MAX_DAYS_TO_EXPIRY) {
      return NextResponse.json({ error: 'expiry too far out' }, { status: 400 })
    }

    const rl = rateLimit(`authorize:${body.address}`, 3600_000, 30)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 },
      )
    }

    // Same halt switch the old deposit rail honoured: when the breaker is
    // tripped the protocol stops quoting, and without a quoter signature no
    // position can open. Fail closed if the state cannot be read.
    try {
      const breaker = await getBreakerState()
      if (breaker.tripped) {
        return NextResponse.json(
          {
            error: `quoting is paused${breaker.reason ? ` — ${breaker.reason}` : ''}`,
            code: 'circuit_breaker_open',
          },
          { status: 503 },
        )
      }
    } catch (breakerErr) {
      console.error('vault/authorize: breaker check unavailable', breakerErr)
      return NextResponse.json(
        { error: 'quote safety check unavailable — please retry', code: 'breaker_unavailable' },
        { status: 503 },
      )
    }

    // ---- re-derive the premium from the engine, never from the request
    let spot: number
    try {
      spot = await fetchXlmUsd()
    } catch (priceErr) {
      console.error('vault/authorize: price feed unavailable', priceErr)
      return NextResponse.json(
        { error: 'price feed unavailable — please retry', code: 'price_feed_unavailable' },
        { status: 503 },
      )
    }

    // ---- concentration policy
    //
    // Checked here rather than at deposit time because this is the last point
    // at which the protocol can still say no: once the quote is signed the
    // position opens on chain, and no server has a say in it after that.
    const expiryIso = new Date(expiryMs).toISOString()
    const notionalUsd =
      body.side === 'call' ? body.collateralAmount * spot : body.collateralAmount
    try {
      await assertQuoteAllowed({
        address: body.address,
        type: body.side,
        collateralAmount: body.collateralAmount,
        notionalUsd,
        strikePrice: body.strikePrice,
        strikeBucketPct: STRIKE_BUCKET_PCT,
        expiryIso,
        maxUserNotionalUsd: MAX_USER_NOTIONAL_USD,
        strikeInventoryLimitUsd: STRIKE_INVENTORY_LIMIT_USD,
        maxUserEpochCallXlm: MAX_USER_EPOCH_CALL_XLM,
        maxUserEpochPutUsd: MAX_USER_EPOCH_PUT_USD,
      })
    } catch (policyErr) {
      if (policyErr instanceof PolicyRejection) {
        return NextResponse.json(
          { error: policyErr.message, code: policyErr.code },
          { status: 409 },
        )
      }
      // An allowance we cannot read has not been satisfied — fail closed.
      console.error('vault/authorize: policy check unavailable', policyErr)
      return NextResponse.json(
        { error: 'deposit limit check unavailable — please retry', code: 'limit_check_unavailable' },
        { status: 503 },
      )
    }

    const utilization = await expiryUtilizationFor(body.side, expiryIso)
    // Price on the time to the expiry the contract will settle against, so a
    // long-dated premium can never be bought for a short-dated lock.
    const pricingDays = Math.max(MIN_DAYS_TO_EXPIRY, Math.ceil(daysToExpiry))
    const { quote } = await quoteOptionLive({
      side: body.side,
      spot,
      strike: body.strikePrice,
      daysToExpiry: pricingDays,
      utilization,
    })

    const units = coveredUnits(body.side, body.collateralAmount, body.strikePrice)
    const quoted = quote.userPremium * units
    if (body.premium > quoted + PREMIUM_TOLERANCE) {
      return NextResponse.json(
        {
          error: `premium ${body.premium.toFixed(7)} exceeds the quote ${quoted.toFixed(7)}`,
          code: 'premium_above_quote',
        },
        { status: 409 },
      )
    }

    // ---- prove the transaction matches what was just priced
    //
    // Everything above validated the request body. This validates the thing
    // actually being signed: same contract, same function, same arguments,
    // byte for byte. Without it a caller could ask for an honest quote and
    // hand over an entry authorizing something else entirely.
    const expected = openArgs({
      owner: body.address,
      side: body.side,
      collateral: body.collateralAmount,
      strike: body.strikePrice,
      expiry: new Date(expiryMs),
      premium: body.premium,
    }).map((v) => v.toXDR('base64'))

    const quoterKey = Keypair.fromSecret(QUOTER_SECRET)
    const quoterAddress = quoterKey.publicKey()

    let entries: xdr.SorobanAuthorizationEntry[]
    try {
      entries = body.authEntries.map((e) =>
        xdr.SorobanAuthorizationEntry.fromXDR(e, 'base64'),
      )
    } catch {
      return NextResponse.json({ error: 'malformed authEntries' }, { status: 400 })
    }

    const target = entries.findIndex((e) => credentialAddress(e) === quoterAddress)
    if (target < 0) {
      return NextResponse.json(
        { error: 'no authorization entry for the quoter', code: 'quoter_entry_missing' },
        { status: 400 },
      )
    }

    const mismatch = describeMismatch(entries[target], {
      contractId: VAULT_ID,
      functionName: 'open',
      args: expected,
      labels: ['owner', 'side', 'collateral', 'strike', 'expiry', 'premium'],
    })
    if (mismatch) {
      return NextResponse.json(
        { error: `authorization entry does not match the quote: ${mismatch}`, code: 'entry_mismatch' },
        { status: 409 },
      )
    }

    // ---- sign, and only this one entry
    const { sequence } = await vaultServer().getLatestLedger()
    const signed = await authorizeEntry(
      entries[target],
      quoterKey,
      sequence + SIGNATURE_LEDGERS,
      NETWORK_PASSPHRASE,
    )

    const out = entries.map((e, i) => (i === target ? signed : e))
    return NextResponse.json({
      ok: true,
      quoter: quoterAddress,
      premium: body.premium,
      quotedPremium: quoted,
      apr: quote.apr,
      validUntilLedger: sequence + SIGNATURE_LEDGERS,
      authEntries: out.map((e) => e.toXDR('base64')),
    })
  } catch (e: any) {
    console.error('vault/authorize failed', e)
    return NextResponse.json(
      { error: 'authorization failed', detail: e?.message ?? 'unknown' },
      { status: 500 },
    )
  }
}

const positive = (n: unknown): n is number =>
  typeof n === 'number' && isFinite(n) && n > 0
