import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { Keypair, StrKey } from '@stellar/stellar-sdk'

// The money routes, asked which underlying they are operating on.
//
// BTC is declared in the registry but gated — no anchor, no instance — so
// every request below that names it is asking for something the rails cannot
// deliver. What matters is that they say so, rather than serving XLM.

const XLM_VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x11))
const WRITER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x66))

const getPosition = vi.fn()
const getSpot = vi.fn()
const logTransaction = vi.fn()

vi.mock('@/lib/vault-contract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../vault-contract')>()),
  getPosition: (...a: any[]) => getPosition(...a),
}))
vi.mock('@/lib/spot', () => ({
  getSpot: (...a: any[]) => getSpot(...a),
  fetchXlmUsd: async () => 0.25,
}))
vi.mock('@/lib/db-queries', () => ({
  logTransaction: (...a: any[]) => logTransaction(...a),
}))
vi.mock('@/lib/idempotency', () => ({
  reserveAction: async () => ({ alreadyProcessed: false }),
  releaseAction: async () => {},
  confirmAction: async () => {},
}))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }))
// Both gate on the database; neither question is about the underlying.
vi.mock('@/lib/circuit-breaker', () => ({
  getBreakerState: async () => ({ tripped: false }),
}))

let deposit: typeof import('@/app/api/vault/deposit/route')
let authorize: typeof import('@/app/api/vault/authorize/route')

beforeAll(async () => {
  process.env.NEXT_PUBLIC_VAULT_CONTRACT = XLM_VAULT
  process.env.VAULT_QUOTER_SECRET = Keypair.random().secret()
  deposit = await import('@/app/api/vault/deposit/route')
  authorize = await import('@/app/api/vault/authorize/route')
})

beforeEach(() => {
  getPosition.mockReset()
  getSpot.mockReset()
  logTransaction.mockReset()
})

const post = (handler: any, body: unknown) =>
  handler(new Request('http://t/api', { method: 'POST', body: JSON.stringify(body) }))

const depositBody = (extra: object = {}) => ({
  address: WRITER,
  txHash: 'abc123',
  positionId: 3,
  type: 'call',
  collateralAmount: 100,
  strikePrice: 0.25,
  daysToExpiry: 7,
  ...extra,
})

const authorizeBody = (extra: object = {}) => ({
  address: WRITER,
  side: 'call',
  collateralAmount: 100,
  strikePrice: 0.25,
  expiryIso: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  premium: 1,
  authEntries: ['AAAA'],
  ...extra,
})

describe('deposit resolves the underlying from the request', () => {
  it('refuses a gated asset instead of indexing another vault s position', async () => {
    const res = await post(deposit.POST, depositBody({ asset: 'BTC' }))

    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('asset_unavailable')
    // The point of refusing early: position #3 exists in XLM's vault and
    // belongs to someone. It must never be read on BTC's behalf.
    expect(getPosition).not.toHaveBeenCalled()
    expect(logTransaction).not.toHaveBeenCalled()
  })

  it('refuses an underlying that does not exist at all', async () => {
    const res = await post(deposit.POST, depositBody({ asset: 'DOGE' }))
    expect(res.status).toBe(400)
    expect(getPosition).not.toHaveBeenCalled()
  })

  it('reads XLM s instance when no underlying is named', async () => {
    getPosition.mockRejectedValue(new Error('stop here'))
    const res = await post(deposit.POST, depositBody())

    // Past the asset gate and into the ledger read — which is as far as this
    // test needs to go. The asset it carried is the assertion.
    expect(res.status).toBe(404)
    expect(getPosition).toHaveBeenCalledWith(3, expect.objectContaining({ symbol: 'XLM' }))
  })
})

describe('authorize resolves the underlying from the request', () => {
  it('refuses to co-sign for a gated asset', async () => {
    const res = await post(authorize.POST, authorizeBody({ asset: 'BTC' }))

    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('asset_unavailable')
    // Refused before a price is fetched, so nothing downstream ever saw a
    // request it would have priced off XLM's market.
    expect(getSpot).not.toHaveBeenCalled()
  })

  it('prices XLM when no underlying is named', async () => {
    getSpot.mockRejectedValue(new Error('feed down'))
    const res = await post(authorize.POST, authorizeBody())

    expect(res.status).toBe(503)
    expect(getSpot).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'XLM' }))
  })
})
