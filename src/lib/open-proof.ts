import { Address, scValToNative, xdr } from '@stellar/stellar-sdk'
import type { UnderlyingAsset } from './assets'
import { findOpenEvent } from './contract-events'
import { HORIZON_URL } from './stellar'
import {
  decodePosition,
  getPosition,
  getPositionIdsOf,
  type VaultPosition,
} from './vault-contract'

/**
 * Is `txHash` the transaction that opened `position`, and when did it land?
 *
 * The `deposit` event says so exactly, but the Soroban RPC keeps events and
 * transactions for a few days only, so a position indexed later could not be
 * proven at all (finding 58). Past that, Horizon still has the transaction:
 * its envelope must be a single successful `open` (or `deposit`) on this
 * instance whose arguments are this position's terms. Horizon no longer
 * returns the result, so it cannot name the id that call produced; if the
 * owner holds another position with identical terms the two transactions are
 * indistinguishable and the claim is refused rather than guessed.
 *
 * Null for "this hash is not the open". Throws when a source cannot be read,
 * so the caller can tell "wrong" from "not now".
 */
export async function proveOpen(
  asset: UnderlyingAsset,
  position: VaultPosition,
  txHash: string,
): Promise<{ at: number } | null> {
  const vault = asset.contracts.vault
  const fromEvents = await findOpenEvent(vault, position.id, txHash)
  if (fromEvents) return fromEvents
  const fromHistory = await openFromHistory(vault, position, txHash)
  if (!fromHistory) return null
  return (await hasTwin(asset, position)) ? null : fromHistory
}

/** Two positions any `open` with these arguments could have produced. */
export function sameTerms(a: VaultPosition, b: VaultPosition): boolean {
  return (
    a.owner === b.owner &&
    a.side === b.side &&
    a.collateral === b.collateral &&
    a.strike === b.strike &&
    a.expiry.getTime() === b.expiry.getTime() &&
    a.premium === b.premium
  )
}

/**
 * The open as Horizon's transaction history records it: when it closed, if its
 * envelope opened a position with exactly these terms on this instance.
 */
export async function openFromHistory(
  contractId: string,
  position: VaultPosition,
  txHash: string,
): Promise<{ at: number } | null> {
  if (!/^[0-9a-f]{64}$/i.test(txHash)) return null
  const hash = txHash.toLowerCase()
  const res = await fetch(`${HORIZON_URL}/transactions/${hash}`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`horizon: ${res.status}`)
  const tx = await res.json()

  // A fee bump answers to two hashes, which is one too many for a key that
  // has to name one open (27). Only a plain, successful transaction counts.
  if (tx?.successful !== true || tx.hash !== hash || tx.fee_bump_transaction) return null
  const env = xdr.TransactionEnvelope.fromXDR(tx.envelope_xdr, 'base64')
  if (env.switch() !== xdr.EnvelopeType.envelopeTypeTx()) return null
  const ops = env.v1().tx().operations()
  if (ops.length !== 1) return null
  const body = ops[0].body()
  if (body.switch() !== xdr.OperationType.invokeHostFunction()) return null
  const fn = body.invokeHostFunctionOp().hostFunction()
  if (fn.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) return null
  const call = fn.invokeContract()
  if (Address.fromScAddress(call.contractAddress()).toString() !== contractId) return null

  const name = call.functionName().toString()
  const args = call.args().map((a) => scValToNative(a))
  let terms: { owner: unknown; kind: unknown; amount: unknown; strike: unknown; expiry: unknown; premium: unknown }
  if (name === 'open' && args.length === 7) {
    const [owner, kind, amount, strike, expiry, premium] = args
    terms = { owner, kind, amount, strike, expiry, premium }
  } else if (name === 'deposit' && args.length === 6) {
    // The covered-call alias: `open` with the call kind.
    const [owner, amount, strike, expiry, premium] = args
    terms = { owner, kind: 0, amount, strike, expiry, premium }
  } else {
    return null
  }

  const claimed = decodePosition(position.id, { ...terms, settled: false, outcome: 'open' })
  if (!sameTerms(claimed, position)) return null
  const at = Date.parse(tx.created_at)
  return Number.isFinite(at) ? { at } : null
}

/** Whether the owner holds another position an identical `open` could have made. */
async function hasTwin(asset: UnderlyingAsset, position: VaultPosition): Promise<boolean> {
  const ids = await getPositionIdsOf(position.owner, 100, asset)
  // The index pages at 100. An owner past that cannot be checked in one read,
  // and an unchecked twin is the one case this proof must not get wrong.
  if (ids.length >= 100) return true
  const others = await Promise.all(
    ids.filter((id) => id !== position.id).map((id) => getPosition(id, asset)),
  )
  return others.some((p) => sameTerms(p, position))
}
