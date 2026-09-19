import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  WebAuth,
} from '@stellar/stellar-sdk'

/**
 * SEP-10 is a login that works by signing a transaction, which makes the
 * client the only thing deciding what the wallet is asked to sign. An anchor
 * that is malicious, compromised, or merely pointed at the wrong network can
 * answer the challenge endpoint with a real transaction — a payment out of the
 * user's own account — and a client that forwards it turns its login button
 * into a signing oracle.
 *
 * So what is asserted here is not that the happy path works. It is that the
 * signer is never called on anything else.
 */

const SERVER = Keypair.random()
const ATTACKER = Keypair.random()
const CLIENT = Keypair.random()
const OTHER_CLIENT = Keypair.random()
// The home domain the section is configured for. The challenge has to be
// issued for this one, not for whatever domain answered the request.
const HOME = 'tr-mock-anchor.fly.dev'

const toml = (over: { signingKey?: string; passphrase?: string } = {}) => `
NETWORK_PASSPHRASE="${over.passphrase ?? Networks.TESTNET}"
SIGNING_KEY="${over.signingKey ?? SERVER.publicKey()}"
WEB_AUTH_ENDPOINT="https://${HOME}/auth"
TRANSFER_SERVER="https://${HOME}/sep6"

[[CURRENCIES]]
code="USDC"
issuer="${Keypair.random().publicKey()}"
`

const challengeFrom = (signer: Keypair, client: string, home = HOME) =>
  WebAuth.buildChallengeTx(signer, client, home, 300, Networks.TESTNET, HOME)

/** A real transaction, signed by the anchor, dressed up as a login. */
const paymentDressedAsChallenge = () => {
  const source = new Account(CLIENT.publicKey(), '101')
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: ATTACKER.publicKey(),
        asset: Asset.native(),
        amount: '5000',
      })
    )
    .setTimeout(300)
    .build()
  tx.sign(SERVER)
  return tx.toXDR()
}

/** Serve the signboard, then the challenge, in the order authenticate asks. */
function serve(tomlText: string, challengeXdr: string | null) {
  return vi.fn().mockImplementation((url: string) => {
    if (String(url).includes('stellar.toml')) {
      return Promise.resolve({ ok: true, status: 200, text: async () => tomlText })
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () =>
        challengeXdr
          ? { transaction: challengeXdr, network_passphrase: Networks.TESTNET }
          : { token: 'header.payload.signature' },
    })
  })
}

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

async function authenticateWith(tomlText: string, challengeXdr: string) {
  vi.stubGlobal('fetch', serve(tomlText, challengeXdr))
  const { authenticate } = await import('@/lib/anchor/session')
  const sign = vi.fn(async (xdr: string) => xdr)
  return { run: () => authenticate(CLIENT.publicKey(), sign), sign }
}

describe('SEP-10 challenge handling', () => {
  it('signs a genuine challenge for this account', async () => {
    const { run, sign } = await authenticateWith(toml(), challengeFrom(SERVER, CLIENT.publicKey()))
    // The POST that exchanges it answers with a token, which is where this stops.
    await run().catch(() => {})
    expect(sign).toHaveBeenCalledOnce()
  })

  /* The one that matters: a payment must never reach the wallet. */
  it('refuses to sign a transaction that is not a challenge', async () => {
    const { run, sign } = await authenticateWith(toml(), paymentDressedAsChallenge())
    await expect(run()).rejects.toThrow(/not a valid SEP-10 challenge/)
    expect(sign).not.toHaveBeenCalled()
  })

  it('refuses a challenge signed by anyone but the declared signing key', async () => {
    const { run, sign } = await authenticateWith(
      toml(),
      challengeFrom(ATTACKER, CLIENT.publicKey())
    )
    await expect(run()).rejects.toThrow(/not a valid SEP-10 challenge/)
    expect(sign).not.toHaveBeenCalled()
  })

  it('refuses a challenge that names a different account', async () => {
    const { run, sign } = await authenticateWith(
      toml(),
      challengeFrom(SERVER, OTHER_CLIENT.publicKey())
    )
    await expect(run()).rejects.toThrow(/different account/)
    expect(sign).not.toHaveBeenCalled()
  })

  it('refuses a challenge issued for a different home domain', async () => {
    const { run, sign } = await authenticateWith(
      toml(),
      challengeFrom(SERVER, CLIENT.publicKey(), 'somewhere-else.example')
    )
    await expect(run()).rejects.toThrow(/not a valid SEP-10 challenge/)
    expect(sign).not.toHaveBeenCalled()
  })

  it('refuses an anchor that publishes no signing key', async () => {
    const { run, sign } = await authenticateWith(
      toml({ signingKey: '' }),
      challengeFrom(SERVER, CLIENT.publicKey())
    )
    await expect(run()).rejects.toThrow(/no SIGNING_KEY/)
    expect(sign).not.toHaveBeenCalled()
  })
})

describe('network enforcement', () => {
  it('refuses an anchor on another network before anything is asked of it', async () => {
    vi.stubGlobal('fetch', serve(toml({ passphrase: Networks.PUBLIC }), null))
    const { loadAnchorToml } = await import('@/lib/anchor/client')
    await expect(loadAnchorToml(HOME)).rejects.toThrow(/different network/)
  })
})
