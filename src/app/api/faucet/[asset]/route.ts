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
import { dripFor, assertDripAllowed, FaucetRejection, type Drip } from '@/lib/faucet'

// The testnet faucet, one asset per request.
// =========================================
// Was /api/faucet/lusd with the asset, the amount and the caps written into
// it. A second underlying makes that shape wrong twice over: the amounts are
// nothing alike — a thousand LUSD against a hundredth of a BTC — and the caps
// that keep the distributor solvent have to be counted per asset, since a
// day's worth of LUSD says nothing about how much LBTC is left.
//
// What every asset shares is the policy: one claim a day, a lifetime bound per
// address, and a daily bound across everyone. That lives in lib/faucet.

const HORIZON = process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org'
const FRIENDBOT = process.env.FRIENDBOT_URL ?? 'https://friendbot.stellar.org'
const DISTRIBUTORS: Record<string, string | undefined> = {
  LUSD: process.env.LUSD_DISTRIBUTOR_SECRET,
  LBTC: process.env.LBTC_DISTRIBUTOR_SECRET,
}

/** Native XLM: Friendbot funds the account, we only record that it happened. */
async function friendbot(address: string): Promise<string | null> {
  const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(address)}`)
  const body = await res.text().catch(() => '')
  if (!res.ok) {
    if (body.includes('op_already_exists') || res.status === 400) {
      throw new Error('This account is already funded on testnet.')
    }
    throw new Error(`Friendbot refused (${res.status}).`)
  }
  try {
    return JSON.parse(body)?.hash ?? null
  } catch {
    return null
  }
}

/** An issued asset: paid from the distributor that holds it. */
async function payFromDistributor(address: string, drip: Drip): Promise<string> {
  const secret = DISTRIBUTORS[drip.symbol]
  if (!secret || !drip.issuer) {
    throw new Error(`The ${drip.symbol} faucet is not configured on this server.`)
  }
  const server = new Horizon.Server(HORIZON)
  const asset = new Asset(drip.code, drip.issuer)

  // A payment to an account that cannot hold the asset fails inside Horizon
  // with a result code nobody can act on. Say which step is missing instead.
  const recipient = await server.loadAccount(address).catch(() => null)
  if (!recipient) {
    throw new Error('Account not found — take the XLM drip first.')
  }
  const holds = recipient.balances.some(
    (b: any) => b.asset_code === drip.code && b.asset_issuer === drip.issuer,
  )
  if (!holds) {
    throw new Error(`Open a ${drip.code} trustline first.`)
  }

  const distributor = Keypair.fromSecret(secret)
  const account = await server.loadAccount(distributor.publicKey())
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination: address, asset, amount: drip.amount }))
    .setTimeout(60)
    .build()
  tx.sign(distributor)
  const res = await server.submitTransaction(tx as any)
  return (res as any).hash
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ asset: string }> },
) {
  try {
    const { asset: raw } = await params
    const drip = dripFor(raw)
    if (!drip) {
      return NextResponse.json(
        { error: `${raw} is not a faucet asset` },
        { status: 404 },
      )
    }

    const { address } = await req.json().catch(() => ({}))
    if (!isValidStellarAddress(address)) {
      return NextResponse.json({ error: 'invalid address' }, { status: 400 })
    }

    // In front of the durable caps rather than instead of them: this one is
    // free and per-instance, those are the ones that actually hold.
    const rl = rateLimit(`faucet:${drip.symbol}:${address}`, 3600_000, 3)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 },
      )
    }

    try {
      await assertDripAllowed(address, drip)
    } catch (capErr) {
      if (capErr instanceof FaucetRejection) {
        return NextResponse.json(
          { error: capErr.message, code: capErr.code, retryAfter: capErr.retryAfter },
          { status: capErr.code === 'daily_cap' ? 503 : 429 },
        )
      }
      // Fail closed. A faucet that pays out whenever its own bookkeeping is
      // down has no limits at all, and this one shares an account with the
      // vault's premiums.
      console.error(`faucet/${drip.symbol}: cap check unavailable`, capErr)
      return NextResponse.json(
        { error: 'faucet temporarily unavailable — retry shortly' },
        { status: 503 },
      )
    }

    const hash =
      drip.issuer === null
        ? await friendbot(address)
        : await payFromDistributor(address, drip)

    // The record IS the cooldown: an unlogged drip is one the next request
    // cannot see, so a failure here is reported rather than swallowed.
    let warning: string | undefined
    try {
      await logTransaction({
        address,
        type: 'faucet',
        amount: parseFloat(drip.amount),
        asset: drip.symbol,
        txHash: hash ?? undefined,
      })
    } catch (dbErr: any) {
      warning = `not recorded: ${dbErr?.message ?? 'unknown DB error'}`
      console.error('faucet: drip not logged', dbErr)
    }

    return NextResponse.json({
      ok: true,
      hash,
      asset: drip.symbol,
      amount: drip.amount,
      ...(warning ? { warning } : {}),
    })
  } catch (e: any) {
    const extras = e?.response?.data?.extras
    return NextResponse.json(
      {
        error: e?.message ?? 'faucet failed',
        detail: extras?.result_codes ?? e?.response?.data?.title ?? undefined,
      },
      { status: 500 },
    )
  }
}
