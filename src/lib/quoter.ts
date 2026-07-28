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
