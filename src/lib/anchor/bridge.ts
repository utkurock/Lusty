'use client'

/**
 * The browser half of the bridge.
 *
 * The crossing is two steps and they are not atomic: the user pays the
 * distributor on chain, then hands the server that transaction's hash and the
 * server pays the other asset back. Nothing here can be trusted by the server
 * — the hash is checked against the ledger — so this file's only job is to
 * build the right payment, ask first whether it can be honoured, and report
 * what came back.
 */

import { Asset, BASE_FEE, Horizon, Operation, TransactionBuilder } from '@stellar/stellar-sdk'
import { HORIZON_URL, NETWORK_PASSPHRASE } from '@/lib/stellar'
import { LUSD_DISTRIBUTOR } from '@/lib/lusd'
import { legsOf, type BridgeDirection } from './bridge-proof'

export type { BridgeDirection }
export { legsOf }

const horizon = new Horizon.Server(HORIZON_URL)

export interface BridgeReadiness {
  ready: boolean
  reason?: string
  /** What the distributor can pay out in the receiving asset right now. */
  float?: string
}

/** Ask before signing: if this is sent, will it come back? */
export async function checkBridge(
  direction: BridgeDirection,
  amount: string
): Promise<BridgeReadiness> {
  const res = await fetch(`/api/anchor/bridge?direction=${direction}&amount=${amount}`, {
    cache: 'no-store',
  })
  const body = await res.json().catch(() => null)
  if (!body) return { ready: false, reason: 'the bridge did not answer' }
  return body as BridgeReadiness
}

/** The payment that funds the crossing, for the user's wallet to sign. */
export async function buildBridgePaymentTx(params: {
  from: string
  direction: BridgeDirection
  amount: string
}): Promise<string> {
  const { pays } = legsOf(params.direction)
  const account = await horizon.loadAccount(params.from)
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(
      Operation.payment({
        destination: LUSD_DISTRIBUTOR,
        asset: new Asset(pays.code, pays.issuer),
        amount: params.amount,
      })
    )
    .setTimeout(120)
    .build()
    .toXDR()
}

export interface BridgeResult {
  sourceAmount: string
  destAmount: string
  payoutHash: string
}

/**
 * Claim the other side.
 *
 * By the time this is called the user's payment is on the ledger and cannot be
 * taken back, so a failure here is money owed, not money lost: the server logs
 * the funding hash, and the same hash can be claimed again once whatever broke
 * is fixed. That is why the error is surfaced with the hash beside it.
 */
export async function claimBridge(params: {
  address: string
  txHash: string
  direction: BridgeDirection
  sourceAmount: number
}): Promise<BridgeResult> {
  const res = await fetch('/api/anchor/bridge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || !body?.ok) {
    throw new Error(body?.error ?? `the bridge refused the claim (${res.status})`)
  }
  return body as BridgeResult
}

/** Which assets an account can hold, and how much of each it has. */
export async function readBridgeBalances(
  address: string
): Promise<Record<string, { trusted: boolean; balance: string }>> {
  const out: Record<string, { trusted: boolean; balance: string }> = {}
  const anchor = legsOf('anchor_to_cash')
  for (const leg of [anchor.pays, anchor.receives]) {
    out[leg.code] = { trusted: false, balance: '0' }
  }
  try {
    const account = await horizon.loadAccount(address)
    for (const leg of [anchor.pays, anchor.receives]) {
      const held = account.balances.find(
        (b: any) => b.asset_code === leg.code && b.asset_issuer === leg.issuer
      ) as any
      out[leg.code] = { trusted: Boolean(held), balance: held?.balance ?? '0' }
    }
  } catch {
    /* an account that does not exist holds nothing, which is what out says */
  }
  return out
}

/** A changeTrust for whichever side the user cannot hold yet. */
export async function buildBridgeTrustlineTx(
  address: string,
  leg: { code: string; issuer: string }
): Promise<string> {
  const account = await horizon.loadAccount(address)
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.changeTrust({ asset: new Asset(leg.code, leg.issuer) }))
    .setTimeout(120)
    .build()
    .toXDR()
}
