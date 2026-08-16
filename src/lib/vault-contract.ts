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
// and nowhere else. Every read goes through simulation and costs nothing. Two
// functions write: `openPosition`, which assembles a transaction the user's own
// wallet signs, and `settlePosition`, which signs with a runner key that the
// contract grants no standing to — see the note there.

import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  Operation,
  StrKey,
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
  /** Premium ceiling, in basis points of the collateral escrowed against it. */
  maxPremiumBps: number
}

export interface VaultConfig {
  oracle: string
  feed: string
  token: string
  cash: string
  treasury: string
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
  /**
   * Which authorised quoter is co-signing this premium. The contract demands
   * authorization from this exact address and checks it against its own set,
   * so it has to be the key the server actually holds — ask
   * `GET /api/vault/authorize` rather than guessing from `quoters()`.
   */
  quoter: string
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
    new Address(args.quoter).toScVal(),
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
    admin: c.admin,
  }
}

/**
 * Every key the contract will accept a premium from. Read from contract state,
 * so the set being enforced can be compared against the one the operator says
 * is in force — the point of keeping the registry on chain.
 */
export async function getVaultQuoters(): Promise<string[]> {
  return await readVault('quoters')
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
    maxPremiumBps: Number(l.max_premium_bps),
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

// ── Writing a position ──────────────────────────────────────────────

/** Co-signs the quoter's authorization entry; see /api/vault/authorize. */
export type QuoterCosigner = (entries: string[]) => Promise<string[]>

export interface OpenPositionParams extends OpenArgs {
  /** Wallet callback: takes a transaction XDR, returns it signed. */
  signTransaction: (xdr: string) => Promise<string>
  cosignQuote: QuoterCosigner
  /** Called as each step completes, for UI progress. */
  onProgress?: (step: 'simulating' | 'quoting' | 'signing' | 'submitting') => void
}

export interface OpenPositionResult {
  /** Contract-assigned position id. */
  id: number
  txHash: string
}

/**
 * Open a position on the vault contract: escrow, premium and position record
 * in a single transaction the user signs from their own wallet.
 *
 * The contract requires authorization from the writer AND the quoter, so this
 * runs the round trip that produces both:
 *
 *   1. simulate the call to learn which entries need authorizing,
 *   2. hand them to the quoter, which re-prices the option and signs its own
 *      entry — and only its own,
 *   3. rebuild the transaction carrying that signature and simulate again to
 *      price the now-larger footprint,
 *   4. the wallet signs the transaction, authorizing the writer's side.
 *
 * Collateral never leaves the user's control on a server's say-so: step 4 is
 * the only signature that moves it, and the user makes it.
 */
export async function openPosition(
  params: OpenPositionParams,
): Promise<OpenPositionResult> {
  const { signTransaction, cosignQuote, onProgress } = params
  const server = vaultServer()
  const contractId = requireVaultId()
  const args = openArgs(params)

  const build = async (auth?: xdr.SorobanAuthorizationEntry[]) => {
    // Re-fetch the account each time: building a transaction consumes the
    // sequence number held on the Account object.
    const account = await server.getAccount(params.owner)
    return new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        auth
          ? Operation.invokeContractFunction({ contract: contractId, function: 'open', args, auth })
          : new Contract(contractId).call('open', ...args),
      )
      .setTimeout(180)
      .build()
  }

  const simulate = async (tx: Awaited<ReturnType<typeof build>>) => {
    const sim = await server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(readableSimError(sim.error, sim.events))
    }
    if (!rpc.Api.isSimulationSuccess(sim)) {
      throw new Error('vault simulation returned no result')
    }
    return sim
  }

  onProgress?.('simulating')
  const probe = await simulate(await build())

  onProgress?.('quoting')
  const unsigned = (probe.result?.auth ?? []).map((e) => e.toXDR('base64'))
  const cosigned = await cosignQuote(unsigned)
  const auth = cosigned.map((e) => xdr.SorobanAuthorizationEntry.fromXDR(e, 'base64'))

  const authorized = await build(auth)
  const sim = await simulate(authorized)
  const prepared = rpc.assembleTransaction(authorized, sim).build()

  onProgress?.('signing')
  const signed = await signTransaction(prepared.toXDR())

  onProgress?.('submitting')
  const sent = await server.sendTransaction(
    TransactionBuilder.fromXDR(signed, NETWORK_PASSPHRASE),
  )
  if (sent.status === 'ERROR') {
    throw new Error(`vault deposit rejected: ${JSON.stringify(sent.errorResult)}`)
  }

  const result = await waitForTransaction(server, sent.hash)
  const id = result.returnValue ? Number(scValToNative(result.returnValue)) : NaN
  if (!isFinite(id)) {
    throw new Error('vault deposit succeeded but returned no position id')
  }
  return { id, txHash: sent.hash }
}

/**
 * Settle one expired position.
 *
 * `settle` is permissionless: the contract asks for no authorization beyond the
 * transaction's own source account, so there is none of the co-signature dance
 * `open` needs — build, sign, send. That also means the key used here holds no
 * privilege whatsoever. It cannot move collateral, change a parameter or
 * influence the outcome; the payout is fixed by the oracle price at the expiry
 * timestamp and goes to the position's owner no matter who makes the call. All
 * this signer does is pay the fee, which is why running it is a convenience
 * rather than a trust assumption: if this runner never ran, any stranger could
 * close the same positions on the same terms.
 */
export async function settlePosition(
  id: number,
  signer: Keypair,
): Promise<{ txHash: string; outcome: string }> {
  const server = vaultServer()
  const contractId = requireVaultId()

  const account = await server.getAccount(signer.publicKey())
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      new Contract(contractId).call('settle', nativeToScVal(BigInt(id), { type: 'u64' })),
    )
    .setTimeout(180)
    .build()

  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(readableContractError(sim.error, 'settle', sim.events))
  }
  if (!rpc.Api.isSimulationSuccess(sim)) {
    throw new Error('vault settle simulation returned no result')
  }

  const prepared = rpc.assembleTransaction(tx, sim).build()
  prepared.sign(signer)

  const sent = await server.sendTransaction(prepared)
  if (sent.status === 'ERROR') {
    throw new Error(`vault settle rejected: ${JSON.stringify(sent.errorResult)}`)
  }

  const result = await waitForTransaction(server, sent.hash, 30, 'settle')
  const outcome = result.returnValue ? String(scValToNative(result.returnValue)) : 'unknown'
  return { txHash: sent.hash, outcome }
}

async function waitForTransaction(
  server: rpc.Server,
  hash: string,
  attempts = 30,
  label = 'deposit',
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  for (let i = 0; i < attempts; i++) {
    const got = await server.getTransaction(hash)
    if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) return got
    if (got.status === rpc.Api.GetTransactionStatus.FAILED) {
      // This is the failure the user is least equipped to explain: they signed,
      // the wallet reported success, and the transaction died in the ledger —
      // state can move between the simulation and the apply. Say what refused
      // it and give the hash, so "I signed and nothing happened" is answerable.
      throw new Error(`Vault ${label} failed on chain — ${onChainReason(got)} · ${hash}`)
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`vault ${label} not confirmed after ${attempts} checks — check ${hash}`)
}

/** Why a submitted transaction failed, as far as the RPC will tell us. */
function onChainReason(failed: rpc.Api.GetFailedTransactionResponse): string {
  const events = failed.diagnosticEventsXdr
  const code = contractErrorCode(events)
  if (code !== null) {
    return readableContractError(`Error(Contract, #${code})`, 'transaction', events)
  }
  // No diagnostics: the transaction-level result code is all there is. It still
  // separates "the contract refused" from "the fee was too low" or "it expired".
  try {
    const outcome = failed.resultXdr.result().switch().name
    return `the network reported ${outcome}`
  } catch {
    return 'no reason reported by the RPC'
  }
}

/** The contract error code carried by a diagnostic event, if any. */
function contractErrorCode(events?: xdr.DiagnosticEvent[]): number | null {
  for (const ev of events ?? []) {
    try {
      for (const topic of ev.event().body().v0().topics()) {
        const native = scValToNative(topic)
        // scValToNative renders a contract error as { type: 'contract', code }.
        if (native?.type === 'contract' && typeof native.code === 'number') {
          return native.code
        }
      }
    } catch {
      continue
    }
  }
  return null
}

// ── Reading a failure ───────────────────────────────────────────────
//
// A contract error arrives as `Error(Contract, #13)` and nothing else: the code
// is scoped to whichever contract raised it, and the invocation touches three.
// The vault's own numbering and the Stellar Asset Contract's overlap across the
// codes that matter most, which made a plain lookup table actively misleading:
//
//   #13   vault: this expiry is full     token: no trustline for the asset
//   #10   vault: the pool cannot cover   token: insufficient balance
//   #11   vault: position too large      token: trustline not authorized
//
// So a writer with no LUSD trustline — the single most common way an open fails
// — was told to pick another expiry, and would have kept picking. The fix is to
// attribute the error before naming it: the failing contract's id is in the
// diagnostic events, both on a simulation error and on an on-chain failure.

/** Vault error codes, as the contract defines them (see contracts/vault). */
const VAULT_ERRORS: Record<number, string> = {
  1: 'Invalid amount',
  2: 'Invalid strike',
  3: 'Expiry must be in the future',
  4: 'Position not found',
  5: 'Position already settled',
  6: 'Position has not expired yet',
  7: 'No oracle price available',
  8: 'Oracle price is stale — settlement is blocked',
  9: 'Invalid premium',
  10: 'The vault pool cannot cover this position',
  11: 'Position is larger than the vault allows',
  12: 'Invalid limit',
  13: 'This expiry is full — pick another',
  14: 'The quoted premium is above what the vault may pay for this collateral',
  15: 'The co-signing key is not an authorised quoter',
  16: 'That quoter is already registered',
  17: 'Cannot remove the last quoter',
  18: 'Too many quoters',
}

/**
 * Stellar Asset Contract error codes — a DIFFERENT numbering that the vault's
 * happens to overlap. Every token move in an open or a settle goes through one
 * of these contracts, so these are the other half of what a code can mean.
 */
const TOKEN_ERRORS: Record<number, string> = {
  1: 'Internal token error',
  2: 'The token does not support that operation',
  3: 'The token is already initialized',
  4: 'Unauthorized token operation',
  5: 'Token authentication failed',
  6: 'That account does not exist on the network',
  7: 'That address is not a classic Stellar account',
  8: 'Negative token amount',
  9: 'Token allowance error',
  10: 'Not enough of the token to send',
  11: 'The trustline is not authorized by the issuer',
  12: 'Token arithmetic overflow',
  13: 'No trustline for the asset — the account cannot receive it',
}

/**
 * Which contract raised the error, from the diagnostic events.
 *
 * The earliest error-topic event carrying a contract id is the origin: a
 * failure is raised in the deepest frame and then propagates outward, so the
 * first one to say "error" is the contract that actually refused. Returns null
 * when the RPC gave us no events to read, which is a normal outcome — some
 * nodes serve simulations with diagnostics off.
 */
function failingContract(events?: xdr.DiagnosticEvent[]): string | null {
  for (const ev of events ?? []) {
    try {
      const event = ev.event()
      const id = event.contractId()
      if (!id) continue
      const isError = event
        .body()
        .v0()
        .topics()
        .some((t) => scValToNative(t) === 'error')
      if (!isError) continue
      return StrKey.encodeContract(id as unknown as Buffer)
    } catch {
      // A topic we cannot decode is not the one we are looking for.
      continue
    }
  }
  return null
}

/**
 * Turn `Error(Contract, #13)` into something a caller can act on.
 *
 * With attribution, one meaning. Without it, BOTH meanings when the code is
 * ambiguous — a message that names two possibilities the reader can check beats
 * one that confidently names the wrong one.
 *
 * Exported for its tests: which of two overlapping tables a code is read from
 * is exactly the kind of decision that should be pinned down by assertions
 * rather than by the next person to hit a failed deposit.
 */
export function readableContractError(
  error: string,
  action = 'deposit',
  events?: xdr.DiagnosticEvent[],
): string {
  const match = error.match(/Error\(Contract, #(\d+)\)/)
  if (!match) return `Vault rejected the ${action}: ${error}`
  const code = Number(match[1])
  const fromVault = VAULT_ERRORS[code]
  const fromToken = TOKEN_ERRORS[code]

  const culprit = failingContract(events)
  if (culprit) {
    if (culprit === VAULT_ID) {
      return fromVault ?? `Vault rejected the ${action}: ${error}`
    }
    // Anything else in this invocation is a token contract: the collateral
    // being escrowed or the cash paying the premium.
    return fromToken
      ? `${fromToken} (token ${culprit.slice(0, 6)}…)`
      : `A token contract rejected the ${action} with code #${code} (${culprit.slice(0, 6)}…)`
  }

  if (fromVault && fromToken) {
    return (
      `The ${action} was rejected with code #${code}, which two of the ` +
      `contracts involved define differently — from the vault it means ` +
      `"${fromVault.toLowerCase()}", from a token contract "${fromToken.toLowerCase()}"`
    )
  }
  if (fromVault) return fromVault
  if (fromToken) return fromToken
  return `Vault rejected the ${action}: ${error}`
}

const readableSimError = (
  error: string,
  events?: xdr.DiagnosticEvent[],
): string => readableContractError(error, 'deposit', events)
