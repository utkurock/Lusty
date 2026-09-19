/**
 * SEP-6: the deposit and withdrawal themselves.
 *
 * SEP-6 is the programmatic half of the standard — the anchor answers with
 * data and we build the screens. (Its sibling SEP-24 hands back a hosted popup
 * instead; this anchor does not implement it, and a ramp that renders inside
 * Lusty is the point of doing it this way.)
 *
 * Both flows are the same three beats: ask the anchor for instructions, act on
 * them off-chain or on-chain, then poll one transaction record until it says
 * completed. The `-exchange` variants are the same endpoints with a SEP-38
 * quote id attached, which is what turns a floating rate into a locked one.
 */

import { anchorCurrency, anchorFetch, loadAnchorToml, query, AnchorError } from './client'
import { ANCHOR_ASSET_CODE, DELIVERY_METHOD, FIAT_ASSET } from './config'
import type { AnchorTransaction, DepositInstructions, WithdrawInstructions } from './types'

async function transferServer(): Promise<string> {
  return (await loadAnchorToml()).transferServer
}

export interface AssetCapability {
  enabled: boolean
  min_amount?: number
  max_amount?: number
  fee_percent?: number
}

export interface AnchorInfo {
  deposit: Record<string, AssetCapability>
  withdraw: Record<string, AssetCapability>
  features?: { account_creation?: boolean; claimable_balances?: boolean }
}

/** What the anchor supports, and the limits it will refuse outside of. */
export async function fetchInfo(): Promise<AnchorInfo> {
  return anchorFetch<AnchorInfo>(`${await transferServer()}/info`)
}

/**
 * Start an on-ramp. The amount is in fiat, because that is what the user is
 * sending: the anchor's minimum is expressed in TRY, and so is the field.
 *
 * With `quoteId` the rate is the one already shown; without it the anchor
 * prices when the money arrives.
 */
export async function startDeposit(params: {
  account: string
  amount: string
  token: string
  quoteId?: string
}): Promise<DepositInstructions> {
  const server = await transferServer()
  const url = params.quoteId
    ? `${server}/deposit-exchange` +
      query({
        destination_asset: ANCHOR_ASSET_CODE,
        source_asset: FIAT_ASSET,
        amount: params.amount,
        account: params.account,
        quote_id: params.quoteId,
        funding_method: DELIVERY_METHOD,
      })
    : `${server}/deposit` +
      query({
        asset_code: ANCHOR_ASSET_CODE,
        account: params.account,
        amount: params.amount,
        funding_method: DELIVERY_METHOD,
      })

  const raw = await anchorFetch<any>(url, { token: params.token })
  return {
    id: raw.id,
    how: raw.how,
    instructions: raw.instructions,
    eta: raw.eta,
    minAmount: raw.min_amount,
    maxAmount: raw.max_amount,
    feePercent: raw.fee_percent,
    extraInfo: raw.extra_info,
  }
}

/**
 * Start an off-ramp. The amount is in the anchored asset here, for the same
 * reason: it is the side the user is about to send.
 */
export async function startWithdraw(params: {
  amount: string
  token: string
  quoteId?: string
}): Promise<WithdrawInstructions> {
  const server = await transferServer()
  const url = params.quoteId
    ? `${server}/withdraw-exchange` +
      query({
        source_asset: ANCHOR_ASSET_CODE,
        destination_asset: FIAT_ASSET,
        amount: params.amount,
        type: DELIVERY_METHOD,
        quote_id: params.quoteId,
      })
    : `${server}/withdraw` +
      query({
        asset_code: ANCHOR_ASSET_CODE,
        type: DELIVERY_METHOD,
        amount: params.amount,
      })

  const raw = await anchorFetch<any>(url, { token: params.token })
  if (!raw.account_id) throw new AnchorError('the anchor returned no account to pay', 0, url)
  return {
    id: raw.id,
    accountId: raw.account_id,
    memo: String(raw.memo),
    memoType: raw.memo_type ?? 'id',
    eta: raw.eta,
    minAmount: raw.min_amount,
    feePercent: raw.fee_percent,
    extraInfo: raw.extra_info,
  }
}

/** One transaction, by the id the start call returned. */
export async function fetchTransaction(id: string, token: string): Promise<AnchorTransaction> {
  const { transaction } = await anchorFetch<{ transaction: AnchorTransaction }>(
    `${await transferServer()}/transaction${query({ id })}`,
    { token }
  )
  return transaction
}

/** Everything this key has ever ramped through the anchor, newest first. */
export async function fetchTransactions(token: string): Promise<AnchorTransaction[]> {
  const { transactions } = await anchorFetch<{ transactions: AnchorTransaction[] }>(
    `${await transferServer()}/transactions${query({ asset_code: ANCHOR_ASSET_CODE })}`,
    { token }
  )
  return transactions ?? []
}

/**
 * Play the bank.
 *
 * This is the one call in the whole section that has no counterpart on a real
 * anchor: there, an actual TRY transfer arrives and the anchor notices. In the
 * sandbox nothing ever arrives unless we say it did, so the deposit screen
 * offers a button that says exactly that.
 */
export async function simulateBankTransfer(id: string, amount: string): Promise<void> {
  await anchorFetch(`${await transferServer()}/tx/${id}/simulate-bank-transfer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount }),
  })
}

/** A status that will not change again without the user doing something. */
export function isSettled(status: string): boolean {
  return ['completed', 'refunded', 'expired', 'error'].includes(status)
}

/** The asset half of `stellar:USDC:G...` or `iso4217:TRY`, for display. */
export function assetLabel(sep38: string | null | undefined): string {
  if (!sep38) return ''
  if (sep38.startsWith('iso4217:')) return sep38.slice('iso4217:'.length)
  const parts = sep38.split(':')
  return parts[1] ?? sep38
}

export { ANCHOR_ASSET_CODE, anchorCurrency }
