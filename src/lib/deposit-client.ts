// Browser side of the position record.
//
// The contract has already written the position by the time this runs: this is
// the mirror the leaderboard, the portfolio and the analytics read, and it is
// best-effort by design — the position exists on chain whether or not the row
// lands.
//
// It is its own module for the same reason quote-client.ts is: the endpoint
// resolves an absent `asset` to XLM, so a body that omits it does not record an
// unlabelled position, it records a BTC position in XLM's book. One place to
// build that body is one place to check it names the asset the page was opened
// for.

import type { OptionSide } from './vault-contract'
import type { UnderlyingSymbol } from './assets'

export interface DepositRecord {
  address: string
  txHash: string
  positionId: number
  type: OptionSide
  /** The underlying whose vault instance wrote this position. */
  asset: UnderlyingSymbol
  collateralAmount: number
  strikePrice: number
  daysToExpiry: number
  expiryIso: string
}

/** Record an opened position. Throws; callers decide what a lost row costs. */
export async function recordDeposit(record: DepositRecord): Promise<void> {
  const res = await fetch('/api/vault/deposit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.error ?? `deposit not recorded (${res.status})`)
  }
}
