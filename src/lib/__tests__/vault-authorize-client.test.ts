import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { Address, Keypair, StrKey, xdr } from '@stellar/stellar-sdk'
import { upcomingExpiryDates } from '../expiries'
import { XLM } from '../assets'

// The co-signature, asked by clients who are not who they say they are.
//
// The address in an authorize request is anybody's to name. Its hourly budget
// used to be keyed on that address alone, so a stranger could spend it and the
// real writer would meet a 429. And a signature, once given, priced a premium
// for eight minutes of spot moving underneath it. Both are bounded here.

const XLM_VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x11))
const QUOTER = Keypair.random()
const VICTIM = Keypair.random().publicKey()
const LATEST_LEDGER = 1_000

const inserts: any[][] = []
vi.mock('@/lib/db', async (importOriginal) => ({
  COLLATERAL_USD_SQL: (await importOriginal<typeof import('../db')>()).COLLATERAL_USD_SQL,
  ensureSchema: async () => {},
  getPool: () => ({
    query: async (sql: string, params: any[] = []) => {
      if (sql.includes('insert into quote_reservations')) inserts.push(params)
      return { rows: [], rowCount: 0 }
    },
  }),
}))
vi.mock('@/lib/circuit-breaker', () => ({ getBreakerState: async () => ({ tripped: false }) }))
vi.mock('@/lib/spot', () => ({
  getSpot: async (asset: any) => ({ price: 0.25, symbol: asset.symbol, source: 'reflector', asOf: Date.now() }),
}))
vi.mock('@/lib/vol', () => ({
  getRealizedVol: async () => ({ sigma: 0.8, sigmaSimple: 0.8, method: 'test', samples: 59, windowDays: 60, asOf: Date.now() }),
}))
vi.mock('@/lib/forward', () => ({
  getForward: async (spot: number, timeYears: number) => ({
    forward: spot, spot, fundingAnnual: 0, source: 'spot-fallback', timeYears,
  }),
}))
vi.mock('@/lib/vault-contract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../vault-contract')>()),
  getVaultLimits: async (asset: any) => asset.onchainLimits,
  getExposure: async () => 0,
  getPositionsOf: async () => [],
  vaultServer: () => ({ getLatestLedger: async () => ({ sequence: LATEST_LEDGER }) }),
}))

let authorize: typeof import('@/app/api/vault/authorize/route')
let openArgs: typeof import('../vault-contract').openArgs

beforeAll(async () => {
  // In-process limits only: the durable store is not what is under test.
  delete process.env.DATABASE_URL
  process.env.NEXT_PUBLIC_VAULT_CONTRACT = XLM_VAULT
  process.env.VAULT_QUOTER_SECRET = QUOTER.secret()
  authorize = await import('@/app/api/vault/authorize/route')
  openArgs = (await import('../vault-contract')).openArgs
})

beforeEach(() => {
  inserts.length = 0
})

const expiry = () => upcomingExpiryDates(new Date(), XLM.expiry)[0]

/** The quoter's entry for `open`, as a wallet's simulation would hand it over. */
function quoterEntry(): string {
  const args = openArgs({
    owner: VICTIM,
    side: 'call',
    collateral: 100,
    strike: 0.3,
    expiry: expiry(),
    premium: 0,
    quoter: QUOTER.publicKey(),
  })
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(QUOTER.publicKey()).toScAddress(),
        nonce: xdr.Int64.fromString('1'),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(XLM_VAULT).toScAddress(),
          functionName: 'open',
          args,
        }),
      ),
      subInvocations: [],
    }),
  }).toXDR('base64')
}

const request = (ip: string, body: unknown) =>
  authorize.POST(
    new Request('http://t/api/vault/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )

const quote = (extra: object = {}) => ({
  address: VICTIM,
  side: 'call',
  collateralAmount: 100,
  strikePrice: 0.3,
  expiryIso: expiry().toISOString(),
  premium: 0,
  authEntries: ['AAAA'],
  ...extra,
})

describe('a stranger cannot spend a wallet s quotes', () => {
  it('30 requests naming a wallet from one client leave another client s request untouched', async () => {
    const stranger = '203.0.113.10'
    for (let i = 0; i < 30; i++) {
      // Every check passes and the placeholder entry is refused — which is
      // where the old address-keyed budget had already been spent.
      expect((await request(stranger, quote())).status).toBe(400)
    }
    expect((await request(stranger, quote())).status).toBe(429)

    const owner = await request('203.0.113.11', quote())
    expect(owner.status).toBe(400)
    expect((await owner.json()).error).toBe('malformed authEntries')
  })

  it('bounds one client across every address it names, before anything is priced', async () => {
    const client = '203.0.113.20'
    for (let i = 0; i < 60; i++) {
      await request(client, quote({ address: Keypair.random().publicKey(), side: 'straddle' }))
    }
    const res = await request(client, quote({ address: Keypair.random().publicKey() }))
    expect(res.status).toBe(429)
  })
})

describe('the body is read with a cap', () => {
  it('answers 413 to an oversized body', async () => {
    const res = await request('203.0.113.30', JSON.stringify({ ...quote(), pad: 'x'.repeat(70 * 1024) }))
    expect(res.status).toBe(413)
  })

  it('answers 400 to a body that is not JSON', async () => {
    expect((await request('203.0.113.31', '{')).status).toBe(400)
  })
})

describe('a signature lasts one wallet prompt, and its reservation outlasts it', () => {
  it('signs for a dozen ledgers and reserves for at least as long at a slow close', async () => {
    const before = Date.now()
    const res = await request('203.0.113.40', quote({ authEntries: [quoterEntry()] }))
    const out = await res.json()
    expect(res.status).toBe(200)

    expect(out.validUntilLedger).toBe(LATEST_LEDGER + 12)
    const signed = xdr.SorobanAuthorizationEntry.fromXDR(out.authEntries[0], 'base64')
    expect(signed.credentials().address().signatureExpirationLedger()).toBe(LATEST_LEDGER + 12)

    // The reservation must not lapse — and be judged unused — while the
    // signature can still open a position: 12 ledgers at 10 s each, and more.
    expect(inserts).toHaveLength(1)
    const validUntil = Date.parse(inserts[0][7])
    expect(validUntil - before).toBeGreaterThanOrEqual(12 * 10_000)
    // And not the old eight-minute-plus window either.
    expect(validUntil - before).toBeLessThan(8 * 60_000)
  })
})
