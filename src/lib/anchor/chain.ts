/**
 * The Stellar side of the ramp: the trustline the deposit needs, and the
 * payment the withdrawal is.
 *
 * Both are classic operations built here and signed by the user's own wallet.
 * Nothing in this file can move anything on its own; it hands back XDR.
 */

import { Asset, BASE_FEE, Horizon, Memo, Operation, TransactionBuilder } from '@stellar/stellar-sdk'
import { HORIZON_URL, NETWORK_PASSPHRASE } from '@/lib/stellar'
import type { AnchorCurrency } from './types'

const horizon = new Horizon.Server(HORIZON_URL)

export function assetOf(currency: AnchorCurrency): Asset {
  return new Asset(currency.code, currency.issuer)
}

export interface AccountAssetState {
  /** Does the account exist on the network at all? */
  funded: boolean
  /** Can it hold the anchored asset? Without this a deposit sits in pending_trust. */
  trusted: boolean
  /** How much of it the account holds, as a decimal string. */
  balance: string
}

/**
 * What the account can do with this asset right now.
 *
 * The deposit screen asks before it starts, because the alternative is a user
 * who has "sent" their TRY and then watches the transaction sit in
 * pending_trust with no explanation of what is missing.
 */
export async function readAssetState(
  address: string,
  currency: AnchorCurrency
): Promise<AccountAssetState> {
  try {
    const account = await horizon.loadAccount(address)
    const line = account.balances.find(
      (b: any) => b.asset_code === currency.code && b.asset_issuer === currency.issuer
    ) as any
    return { funded: true, trusted: Boolean(line), balance: line?.balance ?? '0' }
  } catch {
    return { funded: false, trusted: false, balance: '0' }
  }
}

/** A changeTrust the user signs so the anchor has somewhere to pay. */
export async function buildTrustlineTx(address: string, currency: AnchorCurrency): Promise<string> {
  const account = await horizon.loadAccount(address)
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.changeTrust({ asset: assetOf(currency) }))
    .setTimeout(120)
    .build()
    .toXDR()
}

/**
 * The withdrawal payment.
 *
 * The memo is the whole identity of the order — the anchor has no other way to
 * tell which withdrawal this money settles — so it is attached here rather than
 * left to the wallet, and a payment built any other way would arrive as an
 * anonymous credit to the treasury.
 */
export async function buildWithdrawPaymentTx(params: {
  from: string
  destination: string
  amount: string
  memo: string
  memoType: string
  currency: AnchorCurrency
}): Promise<string> {
  const account = await horizon.loadAccount(params.from)
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: params.destination,
        asset: assetOf(params.currency),
        amount: params.amount,
      })
    )
    .addMemo(params.memoType === 'hash' ? Memo.hash(params.memo) : params.memoType === 'text' ? Memo.text(params.memo) : Memo.id(params.memo))

  return builder.setTimeout(120).build().toXDR()
}

export async function submitSigned(signedXdr: string): Promise<string> {
  const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE)
  const res = await horizon.submitTransaction(tx as any)
  return (res as any).hash
}

/** Horizon's own words when it rejects a transaction, which are the useful ones. */
export function submitFailureReason(e: any): string {
  const codes = e?.response?.data?.extras?.result_codes
  if (codes?.operations?.length) return `the network refused it: ${codes.operations.join(', ')}`
  if (codes?.transaction) return `the network refused it: ${codes.transaction}`
  return e?.message ?? 'the transaction could not be submitted'
}

export const EXPLORER_TX = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`
export const EXPLORER_ACCOUNT = (id: string) => `https://stellar.expert/explorer/testnet/account/${id}`
