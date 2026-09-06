import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { Address, nativeToScVal, rpc, StrKey, xdr } from '@stellar/stellar-sdk'

// Synthetic addresses: well-formed strkeys that name nothing deployed. What is
// under test is which instance a read goes to, not which real one — and a real
// id here would both tie the test to a deployment and teach the next reader
// that BTC settles somewhere it does not.
const fakeContract = (fill: number) => StrKey.encodeContract(Buffer.alloc(32, fill))
const fakeAccount = (fill: number) =>
  StrKey.encodeEd25519PublicKey(Buffer.alloc(32, fill))

const XLM_VAULT = fakeContract(0x11)
const BTC_VAULT = fakeContract(0x22)
const BTC_SAC = fakeContract(0x33)
const BTC_ISSUER = fakeAccount(0x44)

let vault: typeof import('../vault-contract')
let assets: typeof import('../assets')

beforeAll(async () => {
  process.env.NEXT_PUBLIC_VAULT_CONTRACT = XLM_VAULT
  process.env.NEXT_PUBLIC_VAULT_CONTRACT_BTC = BTC_VAULT
  process.env.NEXT_PUBLIC_BTC_ANCHOR_ISSUER = BTC_ISSUER
  process.env.NEXT_PUBLIC_BTC_CONTRACT = BTC_SAC
  vi.resetModules()
  assets = await import('../assets')
  vault = await import('../vault-contract')
})

afterEach(() => vi.restoreAllMocks())

/** Which contract, and which method, a built transaction addresses. */
function target(tx: any): { contract: string; method: string } {
  const args = tx.operations[0].func.invokeContract()
  return {
    contract: Address.fromScAddress(args.contractAddress()).toString(),
    method: args.functionName().toString(),
  }
}

const scaledFields = [
  'escrowed_call',
  'escrowed_put',
  'owed_call',
  'owed_put',
  'cash_balance',
  'underlying_balance',
  'next_id',
] as const

/** A `stats` return whose escrowed_call identifies the book it came from. */
function statsFor(escrowedCall: bigint): xdr.ScVal {
  const value: Record<string, bigint> = { escrowed_call: escrowedCall }
  const type: Record<string, [string, string]> = {}
  for (const f of scaledFields) {
    value[f] ??= 0n
    type[f] = ['symbol', 'i128']
  }
  return nativeToScVal(value, { type } as any)
}

/**
 * Answer every simulation with the book belonging to the contract that was
 * addressed, and record what was asked of whom.
 */
function stubBooks(books: Record<string, bigint>) {
  const seen: { contract: string; method: string }[] = []
  vi.spyOn(rpc.Server.prototype, 'simulateTransaction').mockImplementation(
    async (tx: any) => {
      const t = target(tx)
      seen.push(t)
      return {
        transactionData: {},
        result: { retval: statsFor(books[t.contract] ?? -1n) },
      } as any
    },
  )
  return seen
}

describe('reads address the instance they are given', () => {
  it('returns a different book for each underlying', async () => {
    const seen = stubBooks({ [XLM_VAULT]: 10n, [BTC_VAULT]: 20n })

    const xlm = await vault.getVaultStats(assets.XLM)
    const btc = await vault.getVaultStats(assets.BTC)

    expect(xlm.escrowedCall).toBe(fromStroops(10n))
    expect(btc.escrowedCall).toBe(fromStroops(20n))
    expect(xlm.escrowedCall).not.toBe(btc.escrowedCall)
    expect(seen.map((s) => s.contract)).toEqual([XLM_VAULT, BTC_VAULT])
  })

  it('still defaults to XLM when no asset is named', async () => {
    const seen = stubBooks({ [XLM_VAULT]: 10n })
    await vault.getVaultStats()
    expect(seen[0].contract).toBe(XLM_VAULT)
  })

  it('carries the instance through every read, not just stats', async () => {
    const seen = stubBooks({ [BTC_VAULT]: 1n })

    await vault.getVaultLimits(assets.BTC).catch(() => {})
    await vault.getExposure('call', new Date(), assets.BTC).catch(() => {})
    await vault.getPosition(3, assets.BTC).catch(() => {})
    await vault.getVaultQuoters(assets.BTC).catch(() => {})

    expect(seen.map((s) => s.method)).toEqual([
      'limits',
      'exposure',
      'position',
      'quoters',
    ])
    expect(seen.every((s) => s.contract === BTC_VAULT)).toBe(true)
  })
})

describe('an asset with no instance', () => {
  it('refuses rather than reading another asset s book', async () => {
    vi.resetModules()
    delete process.env.NEXT_PUBLIC_VAULT_CONTRACT_BTC
    const bare = await import('../vault-contract')
    const bareAssets = await import('../assets')
    process.env.NEXT_PUBLIC_VAULT_CONTRACT_BTC = BTC_VAULT

    // The failure that matters: a BTC read landing in XLM's escrow.
    await expect(bare.getVaultStats(bareAssets.BTC)).rejects.toThrow(/BTC/)
  })
})

describe('error attribution across instances', () => {
  it('reads a second instance s code off the vault table', () => {
    // #13 means "expiry full" from a vault and "no trustline" from a token.
    const fromBtcVault = vault.readableContractError(
      'Error(Contract, #13)',
      'deposit',
      [errorEventFrom(BTC_VAULT)],
    )
    expect(fromBtcVault).not.toMatch(/trustline/i)
    expect(fromBtcVault).toBe(
      vault.readableContractError('Error(Contract, #13)', 'deposit', [
        errorEventFrom(XLM_VAULT),
      ]),
    )
  })
})

const anyXdr = xdr as any

/** A diagnostic event naming `contract` as the one that errored. */
function errorEventFrom(contract: string): xdr.DiagnosticEvent {
  const event = new xdr.ContractEvent({
    ext: new anyXdr.ExtensionPoint(0, undefined),
    contractId: Address.fromString(contract).toScAddress().contractId(),
    type: xdr.ContractEventType.contract(),
    body: new anyXdr.ContractEventBody(
      0,
      new xdr.ContractEventV0({
        topics: [nativeToScVal('error', { type: 'symbol' })],
        data: xdr.ScVal.scvVoid(),
      }),
    ),
  })
  return new xdr.DiagnosticEvent({ inSuccessfulContractCall: false, event })
}

const fromStroops = (v: bigint) => Number(v) / 1e7
