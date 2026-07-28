// Soroban client for the Lusty vault contract (contracts/vault).
// ==============================================================
// One place that knows how the contract encodes an option, so the UI, the API
// routes and any auditor all read the same numbers. The contract stores:
//
//   • collateral and cash in 7-decimal token units (stroops),
//   • strikes at the oracle's scale (Reflector: 14 decimals),
//   • the call/put discriminant as a plain u32 (0 = call, 1 = put),
//   • expiries as unix seconds.
//
// Everything crossing into application code is converted to human units here
// and nowhere else. Reads go through simulation only — nothing in this module
// submits, signs or costs anything.

import {
  Account,
  Address,
  Contract,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from '@stellar/stellar-sdk'

export const RPC_URL =
  process.env.SOROBAN_RPC_URL ??
  process.env.NEXT_PUBLIC_RPC_URL ??
  'https://soroban-testnet.stellar.org'

export const NETWORK_PASSPHRASE = Networks.TESTNET

/** The vault instance the app writes to. */
export const VAULT_ID =
  process.env.NEXT_PUBLIC_VAULT_CONTRACT ??
  process.env.VAULT_CONTRACT ??
  ''

export const TOKEN_DECIMALS = 7
export const ORACLE_DECIMALS = 14

export type OptionSide = 'call' | 'put'

/** Contract-side `Kind`, which serializes as a u32. */
const KIND: Record<OptionSide, number> = { call: 0, put: 1 }
const SIDES: OptionSide[] = ['call', 'put']

// Simulation needs *a* source account, not a funded one. The all-zero account
// keeps read paths working before a wallet is connected.
const NULL_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'

export interface VaultPosition {
  id: number
  owner: string
  side: OptionSide
  /** Collateral escrowed — underlying for a call, cash for a put. */
  collateral: number
  /** Strike in USD. */
  strike: number
  expiry: Date
  /** Cash premium paid to the writer at open. */
  premium: number
  settled: boolean
  outcome: 'open' | 'kept' | 'assigned'
}

export interface VaultStats {
  escrowedCall: number
  escrowedPut: number
  owedCall: number
  owedPut: number
  cashBalance: number
  underlyingBalance: number
  nextId: number
}

export interface VaultLimits {
  maxPositionCall: number
  maxPositionPut: number
  maxExpiryCall: number
  maxExpiryPut: number
}

export interface VaultConfig {
  oracle: string
  feed: string
  token: string
  cash: string
  treasury: string
  quoter: string
  admin: string
}

// ── Scaling ─────────────────────────────────────────────────────────
//
// Done on the decimal string rather than by multiplying, so a large collateral
// amount can't silently lose its last stroops to float error on the way in
// (100 XLM × 1e7 is fine; 12,345,678.9 × 1e7 is past 2^53 and is not).
// Anything finer than the target scale resolves to the nearest unit.

function scale(value: number, decimals: number): bigint {
  if (!isFinite(value) || value < 0) {
    throw new Error(`cannot scale ${value}`)
  }
  const [int, frac = ''] = value.toFixed(decimals).split('.')
  return BigInt(int + frac.padEnd(decimals, '0'))
}

function unscale(value: bigint | number | string, decimals: number): number {
  return Number(BigInt(value)) / 10 ** decimals
}

/** Human amount → 7-decimal token units. */
export const toTokenUnits = (amount: number): bigint => scale(amount, TOKEN_DECIMALS)
/** 7-decimal token units → human amount. */
export const fromTokenUnits = (units: bigint | number | string): number =>
  unscale(units, TOKEN_DECIMALS)
/** USD price → the oracle's fixed-point scale. */
export const toOracleScale = (usd: number): bigint => scale(usd, ORACLE_DECIMALS)
/** Oracle fixed-point → USD. */
export const fromOracleScale = (value: bigint | number | string): number =>
  unscale(value, ORACLE_DECIMALS)

/**
 * Units of the underlying an option covers — the quantity being sold at the
 * strike. A call covers its collateral one-for-one; a put covers what its cash
 * buys at the strike. Mirrors the contract's `obligation()`.
 */
export function coveredUnits(side: OptionSide, collateral: number, strike: number): number {
  if (strike <= 0) throw new Error('strike must be positive')
  return side === 'call' ? collateral : collateral / strike
}

// ── Encoding ────────────────────────────────────────────────────────

export const sideToScVal = (side: OptionSide): xdr.ScVal =>
  nativeToScVal(KIND[side], { type: 'u32' })

export const sideFromContract = (kind: number): OptionSide => SIDES[kind] ?? 'call'

export interface OpenArgs {
  owner: string
  side: OptionSide
  /** Collateral in human units of the escrowed token. */
  collateral: number
  /** Strike in USD. */
  strike: number
  /** Settlement time. */
  expiry: Date
  /** Cash premium the vault pays the writer, in human units. */
  premium: number
}

/** Argument list for `open`, in the contract's declared order. */
export function openArgs(args: OpenArgs): xdr.ScVal[] {
  return [
    new Address(args.owner).toScVal(),
    sideToScVal(args.side),
    nativeToScVal(toTokenUnits(args.collateral), { type: 'i128' }),
    nativeToScVal(toOracleScale(args.strike), { type: 'i128' }),
    nativeToScVal(BigInt(Math.floor(args.expiry.getTime() / 1000)), { type: 'u64' }),
    nativeToScVal(toTokenUnits(args.premium), { type: 'i128' }),
  ]
}

// ── Reads ───────────────────────────────────────────────────────────

export function vaultServer(): rpc.Server {
  return new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith('http://') })
}

function requireVaultId(): string {
  if (!VAULT_ID) {
    throw new Error('NEXT_PUBLIC_VAULT_CONTRACT is not configured')
  }
  return VAULT_ID
}

/**
 * Invoke a view by simulation. Never submitted, so it neither costs fees nor
 * needs a funded account — `from` only has to be a well-formed address.
 */
export async function readVault(
  method: string,
  args: xdr.ScVal[] = [],
  from: string = NULL_ACCOUNT,
): Promise<any> {
  const server = vaultServer()
  const contract = new Contract(requireVaultId())
  const tx = new TransactionBuilder(new Account(from, '0'), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build()

  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`vault.${method} failed: ${sim.error}`)
  }
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
    throw new Error(`vault.${method} returned nothing`)
  }
  return scValToNative(sim.result.retval)
}

export async function getVaultConfig(): Promise<VaultConfig> {
  const c = await readVault('config')
  return {
    oracle: c.oracle,
    feed: c.feed,
    token: c.token,
    cash: c.cash,
    treasury: c.treasury,
    quoter: c.quoter,
    admin: c.admin,
  }
}

export async function getVaultStats(): Promise<VaultStats> {
  const s = await readVault('stats')
  return {
    escrowedCall: fromTokenUnits(s.escrowed_call),
    escrowedPut: fromTokenUnits(s.escrowed_put),
    owedCall: fromTokenUnits(s.owed_call),
    owedPut: fromTokenUnits(s.owed_put),
    cashBalance: fromTokenUnits(s.cash_balance),
    underlyingBalance: fromTokenUnits(s.underlying_balance),
    nextId: Number(s.next_id),
  }
}

export async function getVaultLimits(): Promise<VaultLimits> {
  const l = await readVault('limits')
  return {
    maxPositionCall: fromTokenUnits(l.max_position_call),
    maxPositionPut: fromTokenUnits(l.max_position_put),
    maxExpiryCall: fromTokenUnits(l.max_expiry_call),
    maxExpiryPut: fromTokenUnits(l.max_expiry_put),
  }
}

/** Collateral already committed to one expiry — how full that date is. */
export async function getExposure(side: OptionSide, expiry: Date): Promise<number> {
  const raw = await readVault('exposure', [
    sideToScVal(side),
    nativeToScVal(BigInt(Math.floor(expiry.getTime() / 1000)), { type: 'u64' }),
  ])
  return fromTokenUnits(raw)
}

export function decodePosition(id: number, raw: any): VaultPosition {
  return {
    id,
    owner: raw.owner,
    side: sideFromContract(Number(raw.kind)),
    collateral: fromTokenUnits(raw.amount),
    strike: fromOracleScale(raw.strike),
    expiry: new Date(Number(raw.expiry) * 1000),
    premium: fromTokenUnits(raw.premium),
    settled: Boolean(raw.settled),
    outcome: raw.outcome as VaultPosition['outcome'],
  }
}

export async function getPosition(id: number): Promise<VaultPosition> {
  const raw = await readVault('position', [nativeToScVal(BigInt(id), { type: 'u64' })])
  return decodePosition(id, raw)
}

/**
 * Every position an address has written, newest first. Read from the owner
 * index in contract state rather than from events, so history stays readable
 * long after the RPC's event retention window has rolled past the deposit.
 */
export async function getPositionsOf(
  owner: string,
  limit = 100,
): Promise<VaultPosition[]> {
  const count: number = Number(
    await readVault('position_count', [new Address(owner).toScVal()]),
  )
  if (count === 0) return []

  const start = Math.max(0, count - limit)
  const ids: bigint[] = await readVault('positions_of', [
    new Address(owner).toScVal(),
    nativeToScVal(start, { type: 'u32' }),
    nativeToScVal(Math.min(limit, 100), { type: 'u32' }),
  ])

  const positions = await Promise.all(
    ids.map(async (id) => getPosition(Number(id))),
  )
  return positions.reverse()
}
