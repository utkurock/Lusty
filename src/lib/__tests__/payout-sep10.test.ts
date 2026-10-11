import { describe, it, expect } from 'vitest'
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  WebAuth,
} from '@stellar/stellar-sdk'

// What scripts/anchor-bridge-setup.mjs refuses to sign.
// =====================================================
// The setup script logs in to the anchor with the distributor's key — the one
// every payout is signed with. It used to sign whatever transaction the
// anchor's auth endpoint sent back. It now reads the challenge first with
// WebAuth.readChallengeTx, pinned to testnet, the SIGNING_KEY from the anchor's
// stellar.toml, the home domain and the endpoint's host, exactly as below.
// The script runs main() on import and reads .env.local, so it is not imported
// here; this pins the verifier's contract with the arguments the script passes.

const ANCHOR = Keypair.random()
const DISTRIBUTOR = Keypair.random()
const HOME = 'anchor.example'
const AUTH = 'https://anchor.example/auth'

/** The call the script makes, with the same arguments. */
const read = (xdr: string, signingKey = ANCHOR.publicKey()) => {
  const { tx, clientAccountID } = WebAuth.readChallengeTx(
    xdr,
    signingKey,
    Networks.TESTNET,
    HOME,
    new URL(AUTH).host,
  )
  if (clientAccountID !== DISTRIBUTOR.publicKey()) throw new Error('different account')
  return tx
}

const honest = (passphrase = Networks.TESTNET, server = ANCHOR) =>
  WebAuth.buildChallengeTx(server, DISTRIBUTOR.publicKey(), HOME, 300, passphrase, new URL(AUTH).host)

describe('the SEP-10 challenge the distributor signs', () => {
  it('accepts an honest testnet challenge from the anchor s signing key', () => {
    expect(() => read(honest())).not.toThrow()
  })

  it('refuses a transaction that could move money', () => {
    const drain = new TransactionBuilder(new Account(DISTRIBUTOR.publicKey(), '41'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({ destination: ANCHOR.publicKey(), asset: Asset.native(), amount: '1000' }),
      )
      .setTimeout(300)
      .build()
    drain.sign(ANCHOR)
    expect(() => read(drain.toXDR())).toThrow()
  })

  it('refuses a challenge not signed by the toml s SIGNING_KEY', () => {
    expect(() => read(honest(Networks.TESTNET, Keypair.random()))).toThrow()
  })

  it('refuses a challenge built for the public network', () => {
    expect(() => read(honest(Networks.PUBLIC))).toThrow()
  })

  it('refuses a challenge for a different account', () => {
    const other = WebAuth.buildChallengeTx(
      ANCHOR, Keypair.random().publicKey(), HOME, 300, Networks.TESTNET, new URL(AUTH).host,
    )
    expect(() => read(other)).toThrow()
  })
})
