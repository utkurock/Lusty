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
// Must match pricing.ts PROTOCOL_FEE_BPS — kept here to avoid coupling the
// API route to client-side modules. If you change one, change both.
const PROTOCOL_FEE_RATE = 0.25 // 25% revenue share — see pricing.ts for rationale

// Vault capacity. The total XLM the call vault can absorb above its
// baseline. New deposits that would push utilization past this cap are
// rejected so the protocol doesn't take on unbounded short-call exposure.
const VAULT_XLM_BASELINE = Number(process.env.VAULT_XLM_BASELINE ?? 30000)
const VAULT_CAP_XLM = Number(process.env.VAULT_CAP_XLM ?? 1_000_000)
// Per-wallet position cap (in USD notional) — stops a single user from
// monopolizing the entire vault by stacking back-to-back deposits.
const MAX_USER_NOTIONAL_USD = Number(process.env.MAX_USER_NOTIONAL_USD ?? 50_000)
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

    // ---- enforce vault cap
    //
    // The cap is enforced on the call vault's XLM balance because that's
    // the side that takes on short-call exposure. We read the distributor's
    // *current* balance from Horizon (post-deposit) so the check is naturally
    // race-safe: the latest deposit is already included in the balance.
    if (body.type === 'call') {
      try {
        const distAcc = await server.loadAccount(LUSD_DISTRIBUTOR)
        const xlmBalance = parseFloat(
          distAcc.balances.find((b: any) => b.asset_type === 'native')?.balance ?? '0'
        )
        const utilizedXlm = Math.max(0, xlmBalance - VAULT_XLM_BASELINE)
        if (utilizedXlm > VAULT_CAP_XLM) {
          return NextResponse.json(
            {
              error: `vault cap exceeded — ${utilizedXlm.toFixed(0)}/${VAULT_CAP_XLM.toFixed(0)} XLM utilized. Your collateral was received but no upfront will be paid. Withdraw via support.`,
              code: 'cap_exceeded',
            },
            { status: 409 }
          )
        }
      } catch (capErr) {
        console.error('vault/deposit: cap check failed', capErr)
        // Fall through — failing the cap check shouldn't block deposits when
        // Horizon is flaky, but we log it loudly so we notice.
      }
    }

    // ---- enforce per-user and per-strike notional caps
    //
    // Both checks share a single DB connection and a single estimate of
    // notional USD (from the still-needed price feed) so we don't hit
    // Binance twice or the database twice for the same deposit.
    try {
      const { getPool, ensureSchema } = await import('@/lib/db')
      await ensureSchema()
      const pool = getPool()

      // notionalUsd is computed properly below; here we just need an estimate
      // for the limit checks. For puts, paidAmount is already USD-equivalent.
      const estimatedSpot = body.type === 'call'
        ? await fetchXlmUsd().catch(() => 0.12)
        : 1
      const estimatedNotional = body.type === 'call'
        ? paidAmount * estimatedSpot
        : paidAmount

      // Per-user 30-day check
      const userRes = await pool.query(
        `select coalesce(sum(amount), 0)::float as sum
         from transactions
         where address = $1
           and type = 'deposit'
           and (subtype is null or subtype != 'swap')
           and created_at > now() - interval '30 days'`,
        [body.address]
      )
      const existingUserNotional = parseFloat(userRes.rows[0]?.sum ?? '0')
      if (existingUserNotional + estimatedNotional > MAX_USER_NOTIONAL_USD) {
        return NextResponse.json(
          {
            error: `per-wallet 30d limit exceeded — you have $${existingUserNotional.toFixed(0)} of $${MAX_USER_NOTIONAL_USD} already deposited. Wait for some positions to expire.`,
            code: 'user_limit_exceeded',
          },
          { status: 409 }
        )
      }

      // Per-strike 14-day check (only if strikePrice was provided)
      if (typeof body.strikePrice === 'number' && body.strikePrice > 0) {
        const lo = body.strikePrice * (1 - STRIKE_BUCKET_PCT)
        const hi = body.strikePrice * (1 + STRIKE_BUCKET_PCT)
        const strikeRes = await pool.query(
          `select coalesce(sum(amount), 0)::float as sum
           from transactions
           where type = 'deposit'
             and (subtype is null or subtype != 'swap')
             and metadata ? 'strikePrice'
             and (metadata->>'strikePrice')::float8 between $1 and $2
             and created_at > now() - interval '14 days'`,
          [lo, hi]
        )
        const existingStrikeNotional = parseFloat(strikeRes.rows[0]?.sum ?? '0')
        if (existingStrikeNotional + estimatedNotional > STRIKE_INVENTORY_LIMIT_USD) {
          return NextResponse.json(
            {
              error: `strike $${body.strikePrice.toFixed(4)} is full — $${existingStrikeNotional.toFixed(0)} of $${STRIKE_INVENTORY_LIMIT_USD} already sold against this strike. Pick a different strike.`,
              code: 'strike_limit_exceeded',
            },
            { status: 409 }
          )
        }
      }
    } catch (limitErr) {
      console.error('vault/deposit: limit check failed', limitErr)
      // Non-fatal: if DB is down we still allow the deposit rather than block users.
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

    // The frontend already discounted the Black-Scholes fair value by
    // PROTOCOL_FEE_RATE in pricing.ts before computing the displayed APR,
    // so `body.apr` represents what the user will actually receive (not the
    // gross BS APR). We pay that amount directly — no second discount.
    //
    // The fee paid to FEE_WALLET is the protocol's edge, derived so that
    //   user_premium + fee = original BS gross
    //   ⇒ fee = user_premium × (PROTOCOL_FEE_RATE / (1 − PROTOCOL_FEE_RATE))
    // For PROTOCOL_FEE_RATE = 0.25, fee ≈ user_premium × 0.3333.
    const premium = notionalUsd * (body.apr / 100) * (body.daysToExpiry / 365)
    const fee = premium * (PROTOCOL_FEE_RATE / (1 - PROTOCOL_FEE_RATE))
    const grossPremium = premium + fee // == original BS fair value

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

    // Send protocol fee to fee wallet.
    //   1) Preferred: pay LUSD if the fee wallet has a LUSD trustline.
    //   2) Fallback for `call` deposits: pay the equivalent in XLM (no trustline needed).
    //   3) Otherwise: skip and log loudly so we don't silently lose revenue.
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
            Operation.payment({
              destination: FEE_WALLET,
              asset,
              amount: fee.toFixed(7),
            })
          )
          feeSent = true
        } else if (body.type === 'call') {
          // No LUSD trustline — pay the equivalent in native XLM instead.
          const spot = await fetchXlmUsd().catch(() => null)
          if (spot && spot > 0) {
            const feeInXlm = fee / spot
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
        }
        if (!feeSent) {
          feeNote = `FEE_WALLET ${FEE_WALLET} has no LUSD trustline — protocol fee of ${fee.toFixed(4)} LUSD NOT sent. Open a LUSD trustline on the fee wallet to receive fees.`
          console.error('vault/deposit:', feeNote)
        }
      } catch (feeErr: any) {
        feeNote = `FEE_WALLET load failed: ${feeErr?.message ?? 'unknown'} — fee of ${fee.toFixed(4)} LUSD NOT sent.`
        console.error('vault/deposit:', feeNote)
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
