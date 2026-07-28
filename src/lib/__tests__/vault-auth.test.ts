import { describe, it, expect } from 'vitest'
import { Address, Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk'
import { credentialAddress, describeMismatch } from '../vault-auth'
import { openArgs, type OpenArgs } from '../vault-contract'

// A real contract id and two accounts, fixed so the assertions read concretely.
const VAULT = 'CAWDKJUH5WSXJVOOAUGULE4HY2TTYSXUSI5QXTDKUZ6J5L4UTXWPK2Y4'
const OTHER_CONTRACT = 'CASVHBJ7MOZ5YFSVAYXKZFWIYAR6Y3Q4JI2P6GGJMRFUJBZN6APTZEZD'
const WRITER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey()
const QUOTER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey()

const QUOTE: OpenArgs = {
  owner: WRITER,
  side: 'call',
  collateral: 100,
  strike: 0.25,
  expiry: new Date('2026-08-14T16:00:00.000Z'),
  premium: 5,
}

const LABELS = ['owner', 'side', 'collateral', 'strike', 'expiry', 'premium']

function expected(overrides: Partial<OpenArgs> = {}) {
  return {
    contractId: VAULT,
    functionName: 'open',
    args: openArgs({ ...QUOTE, ...overrides }).map((v) => v.toXDR('base64')),
    labels: LABELS,
  }
}

/** An entry authorizing `contractId.fn(...args)` on behalf of `address`. */
function entryFor(
  address: string | null,
  contractId: string,
  fn: string,
  args: xdr.ScVal[],
): xdr.SorobanAuthorizationEntry {
  const credentials =
    address === null
      ? xdr.SorobanCredentials.sorobanCredentialsSourceAccount()
      : xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address: new Address(address).toScAddress(),
            nonce: xdr.Int64.fromString('1'),
            signatureExpirationLedger: 0,
            signature: xdr.ScVal.scvVoid(),
          }),
        )

  return new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function:
        xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(contractId).toScAddress(),
            functionName: fn,
            args,
          }),
        ),
      subInvocations: [],
    }),
  })
}

const openEntry = (overrides: Partial<OpenArgs> = {}) =>
  entryFor(QUOTER, VAULT, 'open', openArgs({ ...QUOTE, ...overrides }))

describe('credentialAddress', () => {
  it('reads the address an entry authorizes for', () => {
    expect(credentialAddress(openEntry())).toBe(QUOTER)
  })

  it('returns null for a source-account entry, which needs no co-signature', () => {
    const entry = entryFor(null, VAULT, 'open', openArgs(QUOTE))
    expect(credentialAddress(entry)).toBeNull()
  })
})

describe('describeMismatch', () => {
  it('accepts the invocation that was priced', () => {
    expect(describeMismatch(openEntry(), expected())).toBeNull()
  })

  // The attack the check exists for: ask for an honest quote, then hand over
  // an entry that pays out far more than the engine agreed to.
  it('catches a premium inflated after the quote', () => {
    const entry = openEntry({ premium: 5000 })
    expect(describeMismatch(entry, expected())).toBe('premium differs')
  })

  it('catches collateral that no longer backs the quoted size', () => {
    const entry = openEntry({ collateral: 1 })
    expect(describeMismatch(entry, expected())).toBe('collateral differs')
  })

  it('catches a swapped side', () => {
    const entry = openEntry({ side: 'put' })
    expect(describeMismatch(entry, expected())).toBe('side differs')
  })

  it('catches a redirected owner', () => {
    const entry = openEntry({ owner: QUOTER })
    expect(describeMismatch(entry, expected())).toBe('owner differs')
  })

  it('catches a shifted expiry', () => {
    const entry = openEntry({ expiry: new Date('2026-12-25T16:00:00.000Z') })
    expect(describeMismatch(entry, expected())).toBe('expiry differs')
  })

  it('catches a different strike', () => {
    const entry = openEntry({ strike: 0.2 })
    expect(describeMismatch(entry, expected())).toBe('strike differs')
  })

  it('refuses another contract wearing the same call shape', () => {
    const entry = entryFor(QUOTER, OTHER_CONTRACT, 'open', openArgs(QUOTE))
    expect(describeMismatch(entry, expected())).toContain('is not the vault')
  })

  it('refuses another function on the vault', () => {
    const entry = entryFor(QUOTER, VAULT, 'set_limits', openArgs(QUOTE))
    expect(describeMismatch(entry, expected())).toBe('function set_limits is not open')
  })

  it('refuses an argument list of the wrong length', () => {
    const entry = entryFor(QUOTER, VAULT, 'open', [
      nativeToScVal(1, { type: 'u32' }),
    ])
    expect(describeMismatch(entry, expected())).toBe('expected 6 arguments, got 1')
  })

  it('refuses an entry that authorizes a contract upload rather than a call', () => {
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function:
          xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractHostFn(
            new xdr.CreateContractArgs({
              contractIdPreimage:
                xdr.ContractIdPreimage.contractIdPreimageFromAsset(
                  xdr.Asset.assetTypeNative(),
                ),
              executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
            }),
          ),
        subInvocations: [],
      }),
    })
    expect(describeMismatch(entry, expected())).toBe('not a contract invocation')
  })
})
