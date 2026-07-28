// Inspection of Soroban authorization entries, for the quoter co-signature.
// =========================================================================
// Signing an authorization entry is signing whatever that entry authorizes —
// not whatever the request body claimed. These helpers read the entry itself
// so the quoter can refuse anything it did not price.

import { Address, xdr } from '@stellar/stellar-sdk'

/**
 * The address an entry authorizes for, or null when it carries source-account
 * credentials (satisfied by the transaction signature, nothing to co-sign).
 */
export function credentialAddress(entry: xdr.SorobanAuthorizationEntry): string | null {
  const creds = entry.credentials()
  if (creds.switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
    return null
  }
  try {
    return Address.fromScAddress(creds.address().address()).toString()
  } catch {
    return null
  }
}

export interface ExpectedInvocation {
  contractId: string
  functionName: string
  /** Base64-encoded ScVals, in the contract's declared argument order. */
  args: string[]
  /** Argument names, used only to say which one differs. */
  labels?: string[]
}

/**
 * Why `entry` is not the invocation described by `expected`, or null if it
 * matches. Returns a reason rather than a boolean so a mismatch is
 * diagnosable — and so a silent `false` can never read as "close enough".
 */
export function describeMismatch(
  entry: xdr.SorobanAuthorizationEntry,
  expected: ExpectedInvocation,
): string | null {
  const fn = entry.rootInvocation().function()
  if (
    fn.switch() !==
    xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()
  ) {
    return 'not a contract invocation'
  }
  const call = fn.contractFn()

  const contractId = Address.fromScAddress(call.contractAddress()).toString()
  if (contractId !== expected.contractId) {
    return `contract ${contractId} is not the vault`
  }
  const name = call.functionName().toString()
  if (name !== expected.functionName) {
    return `function ${name} is not ${expected.functionName}`
  }

  const args = call.args()
  if (args.length !== expected.args.length) {
    return `expected ${expected.args.length} arguments, got ${args.length}`
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i].toXDR('base64') !== expected.args[i]) {
      return `${expected.labels?.[i] ?? `argument ${i}`} differs`
    }
  }
  return null
}
