// Reflector oracle client (server-side, via Soroban RPC simulation).
// =================================================================
// THE settlement price source. The off-chain vault and the on-chain Soroban
// contract (contracts/vault) read the same Reflector feed, so a position
// settles at the same number regardless of which rail it lives on. Binance
// remains a fallback for settlement and the primary source for quote INPUTS
// (realized vol, perp-funding forward) where Reflector has no equivalent data.
//
// Reads are free simulations (no tx submitted, no fees, no signing) — the
// distributor key is never touched here.

import {
  Account,
  BASE_FEE,
  Contract,
  Networks,
  SorobanRpc,
  StrKey,
  TransactionBuilder,
  scValToNative,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'

const RPC_URL =
  process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org'
// Reflector "external CEX & DEX" feed on testnet.
const ORACLE_ID =
  process.env.REFLECTOR_ORACLE_ID ??
  'CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63'
const FEED_SYMBOL = process.env.REFLECTOR_FEED_SYMBOL ?? 'XLM'
// Feed parameters (constant per oracle deployment; see contracts/README.md).
const DECIMALS = Number(process.env.REFLECTOR_DECIMALS ?? 14)
const RESOLUTION_SECS = Number(process.env.REFLECTOR_RESOLUTION_SECS ?? 300)
// Reject a lastprice fallback older than this — mirrors the Soroban contract.
const MAX_STALENESS_SECS = 3600
export const REFLECTOR_MAX_STALENESS_SECS = MAX_STALENESS_SECS

// Simulation source. It signs nothing, is never charged a fee, and does not
// even have to EXIST on the network — `simulateTransaction` only needs a
// syntactically valid account id. So when no distributor is configured we fall
// back to the all-zero account rather than throwing: an unset env var must not
// be able to take down the oracle and leave the price path with no source.
const NULL_ACCOUNT = StrKey.encodeEd25519PublicKey(Buffer.alloc(32))
const SIM_SOURCE =
  process.env.NEXT_PUBLIC_LUSD_DISTRIBUTOR ||
  process.env.LUSD_DISTRIBUTOR ||
  NULL_ACCOUNT

export interface ReflectorPrice {
  /** USD price as a float (descaled from the oracle's 14 decimals). */
  price: number
  /** Unix seconds of the oracle record. */
  timestamp: number
}

async function simulateOracleCall(
  fn: string,
  args: xdr.ScVal[]
): Promise<ReflectorPrice | null> {
  const rpc = new SorobanRpc.Server(RPC_URL)
  const contract = new Contract(ORACLE_ID)
  // Sequence number is irrelevant for simulation — skip the getAccount round trip.
  const source = new Account(SIM_SOURCE, '0')
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(contract.call(fn, ...args))
    .setTimeout(30)
    .build()

  const sim = await rpc.simulateTransaction(tx)
  if (!SorobanRpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new Error(`reflector: ${fn} simulation failed`)
  }
  const native = scValToNative(sim.result.retval) as
    | { price: bigint; timestamp: bigint }
    | null
  if (!native) return null
  const price = Number(native.price) / 10 ** DECIMALS
  const timestamp = Number(native.timestamp)
  // A malformed record is indistinguishable from "no record" to every caller —
  // both mean "do not price off this". Never hand back a NaN/0 price.
  if (!isFinite(price) || price <= 0 || !isFinite(timestamp)) return null
  return { price, timestamp }
}

function feedAsset(): xdr.ScVal {
  // Reflector Asset enum: Other(Symbol) — encoded as a vec [variant, value].
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('Other'),
    xdr.ScVal.scvSymbol(FEED_SYMBOL),
  ])
}

/**
 * Price at a specific moment (unix ms), normalized to the feed's resolution
 * grid — used for expiry-pinned settlement. Returns null if the oracle has
 * no record for that period (not yet recorded, or pruned past retention).
 */
export async function reflectorPriceAt(atMs: number): Promise<number | null> {
  const tsSecs = Math.floor(atMs / 1000)
  const tsNorm = tsSecs - (tsSecs % RESOLUTION_SECS)
  const rec = await simulateOracleCall('price', [
    feedAsset(),
    nativeToScVal(tsNorm, { type: 'u64' }),
  ])
  return rec === null ? null : rec.price
}

/**
 * Latest feed price, accepted only while fresh (≤ 1h, same rule as the
 * Soroban contract). Returns null when stale or missing — callers fall
 * back to the next source rather than settling on bad data.
 *
 * SECURITY: this is the LIVE price, not an expiry-pinned one. It is only a
 * safe settlement source when the claim happens within the staleness window
 * OF EXPIRY — i.e. the expiry record has not landed yet. For an old expiry
 * (history pruned) the live price is whatever the market is doing now, which
 * would hand the writer exactly the timing discretion expiry-pinning removes.
 * Callers must gate this on `now - expiry`, not just on `now - lastprice.ts`.
 * See settlementPinnedToExpiry() for the safe wrapper.
 */
/**
 * Raw latest feed record — price AND its oracle timestamp, with no staleness
 * judgement applied. Callers decide their own freshness bound, because the
 * right bound depends on the job: settlement tolerates up to an hour (it only
 * ever runs near expiry), live quoting does not. See spot.ts.
 */
export async function reflectorLastPriceRecord(): Promise<ReflectorPrice | null> {
  return simulateOracleCall('lastprice', [feedAsset()])
}

export async function reflectorLastPrice(): Promise<number | null> {
  const rec = await reflectorLastPriceRecord()
  if (rec === null) return null
  const ageSecs = Math.floor(Date.now() / 1000) - rec.timestamp
  if (ageSecs > MAX_STALENESS_SECS) {
    console.warn(`reflector: lastprice stale (${ageSecs}s old) — ignoring`)
    return null
  }
  return rec.price
}

/**
 * Reflector settlement price for a position expiring at `expiryMs`, with the
 * timing-discretion guard applied:
 *
 *   1. The expiry-pinned historical price, if Reflector still has it.
 *   2. Otherwise the live price, but ONLY if the claim is prompt — within the
 *      staleness window of expiry, before the period record is queryable.
 *
 * Returns null when neither applies (old expiry, history pruned). The caller
 * must then use another expiry-pinned source (Binance kline) and must NOT
 * fall back to any live price. Reflector retains ~24h of history, so a writer
 * who waits longer hits this null path rather than settling at a stale-but-
 * "fresh-looking" live price.
 */
export async function reflectorSettlementPrice(
  expiryMs: number
): Promise<number | null> {
  const pinned = await reflectorPriceAt(expiryMs)
  if (pinned !== null) return pinned

  const sinceExpirySecs = Math.floor((Date.now() - expiryMs) / 1000)
  if (sinceExpirySecs > MAX_STALENESS_SECS) {
    // Claim is late and the expiry record is gone — the live price is no
    // longer a proxy for the expiry price. Refuse, don't guess.
    return null
  }
  return reflectorLastPrice()
}
