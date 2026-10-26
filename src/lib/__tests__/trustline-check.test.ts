import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { Horizon, Keypair, StrKey } from '@stellar/stellar-sdk'

// Finding 56: Horizon down is not "no trustline".
// ===============================================
// hasTrustline used to answer false for any failed read, so during a Horizon
// outage the co-signature told a BTC writer to open an LBTC trustline they
// already held. It still refused, which is the safe direction, but for the
// wrong reason. Now only a 404 (an account Horizon has never seen) means no
// trustline; anything else is an outage and says so.

const XLM_VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x11))
const BTC_VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x22))
const BTC_TOKEN = StrKey.encodeContract(Buffer.alloc(32, 0x33))
const LBTC_ISSUER = Keypair.random().publicKey()
const WRITER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x66))

const horizon = vi.hoisted(() => ({ answer: 'holds' as 'holds' | 'missing' | 'down' }))

vi.spyOn(Horizon.Server.prototype, 'loadAccount').mockImplementation(async () => {
  if (horizon.answer === 'down') {
    throw Object.assign(new Error('Request failed with status code 503'), {
      response: { status: 503 },
    })
  }
  if (horizon.answer === 'missing') {
    throw Object.assign(new Error('Not Found'), { response: { status: 404 } })
  }
  return { balances: [{ asset_code: 'LBTC', asset_issuer: LBTC_ISSUER }] } as any
})

vi.mock('@/lib/db', async (importOriginal) => ({
  COLLATERAL_USD_SQL: (await importOriginal<typeof import('../db')>()).COLLATERAL_USD_SQL,
  ensureSchema: async () => {},
  getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
}))
vi.mock('@/lib/vault-contract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../vault-contract')>()),
  getVaultLimits: async (asset: any) => asset.onchainLimits,
  getExposure: async () => 0,
}))
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ ok: true }),
  durableRateLimit: async () => ({ ok: true }),
}))

let swap: typeof import('../swap')
let authorize: typeof import('@/app/api/vault/authorize/route')
let btcExpiry: string

beforeAll(async () => {
  process.env.NEXT_PUBLIC_VAULT_CONTRACT = XLM_VAULT
  process.env.NEXT_PUBLIC_VAULT_CONTRACT_BTC = BTC_VAULT
  process.env.NEXT_PUBLIC_BTC_CONTRACT = BTC_TOKEN
  process.env.NEXT_PUBLIC_BTC_ANCHOR_CODE = 'LBTC'
  process.env.NEXT_PUBLIC_BTC_ANCHOR_ISSUER = LBTC_ISSUER
  process.env.VAULT_QUOTER_SECRET = Keypair.random().secret()
  swap = await import('../swap')
  authorize = await import('@/app/api/vault/authorize/route')
  const { BTC } = await import('../assets')
  const { upcomingExpiryDates } = await import('../expiries')
  btcExpiry = upcomingExpiryDates(new Date(), BTC.expiry)[0].toISOString()
})

beforeEach(() => {
  horizon.answer = 'holds'
})

const LBTC = () => ({ kind: 'issued' as const, code: 'LBTC', issuer: LBTC_ISSUER })

describe('hasTrustline', () => {
  it('answers true when the account holds the trustline', async () => {
    expect(await swap.hasTrustline(WRITER, LBTC())).toBe(true)
  })

  it('answers false for an account Horizon has never seen', async () => {
    horizon.answer = 'missing'
    expect(await swap.hasTrustline(WRITER, LBTC())).toBe(false)
  })

  it('throws instead of answering false when Horizon cannot be read', async () => {
    horizon.answer = 'down'
    await expect(swap.hasTrustline(WRITER, LBTC())).rejects.toBeInstanceOf(
      swap.TrustlineCheckUnavailable,
    )
  })
})

const cosignBtc = async () => {
  const res = await authorize.POST(
    new Request('http://t/api/vault/authorize', {
      method: 'POST',
      body: JSON.stringify({
        address: WRITER,
        asset: 'BTC',
        side: 'call',
        collateralAmount: 0.01,
        strikePrice: 90_000,
        expiryIso: btcExpiry,
        premium: 0,
        authEntries: ['AAAA'],
      }),
    }),
  )
  return { status: res.status, body: await res.json() }
}

describe('the co-signature on an issued book', () => {
  it('Horizon down: refused as retryable, not as a missing trustline', async () => {
    horizon.answer = 'down'
    const { status, body } = await cosignBtc()
    expect(status).toBe(503)
    expect(body.code).toBe('trustline_check_unavailable')
    expect(body.authEntries).toBeUndefined()
  })

  it('account unknown to Horizon: still told to open the trustline', async () => {
    horizon.answer = 'missing'
    const { status, body } = await cosignBtc()
    expect(status).toBe(400)
    expect(body.code).toBe('trustline_required')
  })

  it('trustline held: passes the check and goes on to the next one', async () => {
    const { body } = await cosignBtc()
    expect(body.code).not.toBe('trustline_required')
    expect(body.code).not.toBe('trustline_check_unavailable')
  })
})
