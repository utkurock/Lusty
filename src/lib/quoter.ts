// Client side of the quoter co-signature.
//
// The vault contract will not open a position without the protocol's signature
// on the premium. This asks for it. If the quoter disagrees with the premium
// encoded in the transaction — or the transaction does not match the quote it
// was asked about — it refuses, and the position simply never opens.

import type { OptionSide } from './vault-contract'

export interface CosignRequest {
  address: string
  side: OptionSide
  collateralAmount: number
  strikePrice: number
  expiryIso: string
  premium: number
  /** Base64 auth entries from simulating the `open` invocation. */
  authEntries: string[]
}

/**
 * Which quoter to name in the `open` call. Asked before the transaction is
 * built, because the contract takes the signing address as an argument and
 * will reject any address outside its own set — so this has to be the key the
 * server holds, not whichever member of `quoters()` happens to be first.
 */
export async function activeQuoter(): Promise<string> {
  const res = await fetch('/api/vault/authorize')
  const data = await res.json().catch(() => ({}))
  if (!res.ok || typeof data.quoter !== 'string') {
    throw new Error(data?.error ?? 'The protocol is not quoting right now')
  }
  return data.quoter
}

export async function cosignWithQuoter(req: CosignRequest): Promise<string[]> {
  const res = await fetch('/api/vault/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data?.error ?? 'The protocol declined to sign this quote')
  }
  if (!Array.isArray(data.authEntries) || data.authEntries.length === 0) {
    throw new Error('The protocol returned no signature')
  }
  return data.authEntries as string[]
}
