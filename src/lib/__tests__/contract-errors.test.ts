import { describe, it, expect, beforeAll } from 'vitest'
import { StrKey, xdr } from '@stellar/stellar-sdk'

// Two contracts in the same invocation number their errors differently, and the
// ranges overlap. #13 is the one that cost real time: from the vault it means
// the expiry is full, from a token contract it means the account has no
// trustline — so a writer who needed a trustline was told to pick another
// expiry. These tests pin down which table each code is read from.

const VAULT = 'CBJZGTCF2PJVHX2BNFTFZ2L2LX6DWD5JMTLHNCVYTSOD3BLVSXZRUCJZ'
const TOKEN = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'

type Describe = (
  error: string,
  action?: string,
  events?: xdr.DiagnosticEvent[],
) => string

let readableContractError: Describe

beforeAll(async () => {
  // VAULT_ID is read at module load, so the env has to be in place first.
  process.env.NEXT_PUBLIC_VAULT_CONTRACT = VAULT
  ;({ readableContractError } = await import('../vault-contract'))
})

// js-xdr unions whose only arm is case 0 have no named constructor to call, so
// they are built through the union constructor directly. The typings do not
// describe that, hence the casts — the events themselves are real XDR, and are
// round-tripped below to prove it.
const anyXdr = xdr as any
const extensionPoint = () => new anyXdr.ExtensionPoint(0, undefined)
const eventBody = (v0: xdr.ContractEventV0) => new anyXdr.ContractEventBody(0, v0)

function diagnosticEvent(
  contractId: string | null,
  topics: xdr.ScVal[],
): xdr.DiagnosticEvent {
  const event = new xdr.ContractEvent({
    ext: extensionPoint(),
    contractId: contractId
      ? (StrKey.decodeContract(contractId) as unknown as xdr.ContractId)
      : null,
    type: xdr.ContractEventType.diagnostic(),
    body: eventBody(new xdr.ContractEventV0({ topics, data: xdr.ScVal.scvVoid() })),
  })
  const built = new xdr.DiagnosticEvent({ inSuccessfulContractCall: false, event })
  // Through the wire and back, so these fixtures are exactly what the RPC hands
  // us rather than objects that merely look like it.
  return xdr.DiagnosticEvent.fromXDR(built.toXDR())
}

/** A diagnostic event as the host emits one when a contract raises an error. */
const errorEvent = (contractId: string | null, code: number) =>
  diagnosticEvent(contractId, [
    xdr.ScVal.scvSymbol('error'),
    xdr.ScVal.scvError(xdr.ScError.sceContract(code)),
  ])

/** A non-error event, to prove attribution ignores the rest of the log. */
const callEvent = (contractId: string) =>
  diagnosticEvent(contractId, [xdr.ScVal.scvSymbol('fn_call')])

const ERR_13 = 'HostError: Error(Contract, #13)'

describe('readableContractError', () => {
  it('reads #13 as a missing trustline when a token raised it', () => {
    const msg = readableContractError(ERR_13, 'deposit', [
      callEvent(VAULT),
      errorEvent(TOKEN, 13),
    ])
    expect(msg).toMatch(/trustline/i)
    expect(msg).not.toMatch(/expiry is full/i)
  })

  it('reads #13 as a full expiry when the vault raised it', () => {
    const msg = readableContractError(ERR_13, 'deposit', [
      callEvent(VAULT),
      errorEvent(VAULT, 13),
    ])
    expect(msg).toBe('This expiry is full — pick another')
  })

  it('attributes to the innermost failure, not the outermost frame', () => {
    // The token refuses first; the vault's frame fails on the way out.
    const msg = readableContractError(ERR_13, 'deposit', [
      callEvent(VAULT),
      errorEvent(TOKEN, 13),
      errorEvent(VAULT, 13),
    ])
    expect(msg).toMatch(/trustline/i)
  })

  it('offers both meanings when the RPC gave us nothing to attribute with', () => {
    const msg = readableContractError(ERR_13, 'deposit')
    expect(msg).toMatch(/expiry is full/i)
    expect(msg).toMatch(/trustline/i)
    expect(msg).toMatch(/#13/)
  })

  it('names codes only the vault defines without hedging', () => {
    expect(readableContractError('Error(Contract, #14)')).toMatch(/above what the vault may pay/i)
    expect(readableContractError('Error(Contract, #15)')).toMatch(/not an authorised quoter/i)
  })

  it('names codes only a token defines without hedging', () => {
    expect(readableContractError('Error(Contract, #6)')).toMatch(/does not exist/i)
  })

  it('falls back to the raw error when there is no contract code in it', () => {
    const msg = readableContractError('resource limit exceeded', 'settle')
    expect(msg).toBe('Vault rejected the settle: resource limit exceeded')
  })
})
