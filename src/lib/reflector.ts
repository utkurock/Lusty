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

// Any funded account works as the simulation source; it signs nothing.
const SIM_SOURCE =
  process.env.NEXT_PUBLIC_LUSD_DISTRIBUTOR ??
  process.env.LUSD_DISTRIBUTOR ??
  ''

interface ReflectorPrice {
  /** USD price as a float (descaled from the oracle's 14 decimals). */
  price: number
  /** Unix seconds of the oracle record. */
  timestamp: number
}

async function simulateOracleCall(
  fn: string,
  args: xdr.ScVal[]
): Promise<ReflectorPrice | null> {
  if (!SIM_SOURCE) throw new Error('reflector: no simulation source account')
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
  return {
    price: Number(native.price) / 10 ** DECIMALS,
    timestamp: Number(native.timestamp),
  }
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
 */
export async function reflectorLastPrice(): Promise<number | null> {
  const rec = await simulateOracleCall('lastprice', [feedAsset()])
  if (rec === null) return null
  const ageSecs = Math.floor(Date.now() / 1000) - rec.timestamp
  if (ageSecs > MAX_STALENESS_SECS) {
    console.warn(`reflector: lastprice stale (${ageSecs}s old) — ignoring`)
    return null
  }
  return rec.price
}
