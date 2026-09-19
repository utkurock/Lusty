/** The shapes the anchor answers with, as the SEPs define them. */

export interface AnchorCurrency {
  code: string
  issuer: string
  displayDecimals: number
  desc?: string
}

/** SEP-1: what the home domain's stellar.toml advertises. */
export interface AnchorToml {
  homeDomain: string
  networkPassphrase: string
  signingKey: string
  webAuthEndpoint: string
  transferServer: string
  kycServer?: string
  quoteServer?: string
  accounts: string[]
  orgName?: string
  orgDescription?: string
  currencies: AnchorCurrency[]
}

/** SEP-10: an authenticated session, held only for the browser tab. */
export interface AnchorSession {
  account: string
  token: string
  /** Unix seconds, read off the JWT so an expired token is never sent. */
  expiresAt: number
}

/** SEP-38: an indicative price, or a firm quote with an id and an expiry. */
export interface AnchorPrice {
  /** Units of sell asset per unit of buy asset, fee included. */
  totalPrice: string
  /** The same ratio before the spread. */
  price: string
  sellAmount: string
  buyAmount: string
  fee: { total: string; asset: string; details?: { name: string; description?: string; amount: string }[] }
}

export interface AnchorQuote extends AnchorPrice {
  id: string
  expiresAt: string
  sellAsset: string
  buyAsset: string
}

/** SEP-6 deposit: the bank instructions the user has to act on. */
export interface DepositInstructions {
  id: string
  how?: string
  instructions?: Record<string, { value: string; description?: string }>
  eta?: number
  minAmount?: number
  maxAmount?: number
  feePercent?: number
  extraInfo?: { message?: string }
}

/** SEP-6 withdraw: where to send the asset, and under which memo. */
export interface WithdrawInstructions {
  id: string
  accountId: string
  memo: string
  memoType: string
  eta?: number
  minAmount?: number
  feePercent?: number
  extraInfo?: { message?: string; payment_uri?: string }
}

export type AnchorTxStatus =
  | 'incomplete'
  | 'pending_user_transfer_start'
  | 'pending_user_transfer_complete'
  | 'pending_external'
  | 'pending_anchor'
  | 'pending_stellar'
  | 'pending_trust'
  | 'pending_customer_info_update'
  | 'completed'
  | 'refunded'
  | 'expired'
  | 'error'

/** SEP-6 /transaction, trimmed to the fields this section renders. */
export interface AnchorTransaction {
  id: string
  kind: 'deposit' | 'withdrawal' | string
  status: AnchorTxStatus
  status_eta?: number | null
  message?: string | null
  more_info_url?: string
  started_at?: string
  completed_at?: string | null
  amount_in?: string | null
  amount_in_asset?: string | null
  amount_out?: string | null
  amount_out_asset?: string | null
  amount_fee?: string | null
  amount_fee_asset?: string | null
  from?: string | null
  to?: string | null
  stellar_transaction_id?: string | null
  external_transaction_id?: string | null
  claimable_balance_id?: string | null
  withdraw_anchor_account?: string | null
  withdraw_memo?: string | null
  withdraw_memo_type?: string | null
  instructions?: Record<string, { value: string; description?: string }>
}
