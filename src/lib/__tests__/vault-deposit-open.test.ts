import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { Keypair, StrKey } from '@stellar/stellar-sdk'

// The indexer, asked to record a position by somebody who may not be its owner,
// at a time of their choosing, under a hash of their choosing.
//
// What a position opened at — its time and its price — is decided by the
// ledger and by the quote that opened it. Nothing the caller controls (when
// they call, which hash they name, what tenor they claim) may move it, and a
// request that cannot be checked right now records nothing at all.

const XLM_VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x11))
const OWNER = Keypair.random().publicKey()
const OPEN_TX = 'ab'.repeat(32)
const DAY = 86_400_000

const getPosition = vi.fn()
const findOpenEvent = vi.fn()
const reservedOpenPrice = vi.fn()
const markReservationIndexed = vi.fn(async () => {})
const logTransaction = vi.fn(async (..._a: any[]) => {})
const reserveAction = vi.fn(async (..._a: any[]) => ({ alreadyProcessed: false }))
const getSpot = vi.fn(async () => ({ price: 9.99 }))

vi.mock('@/lib/vault-contract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../vault-contract')>()),
  getPosition: (...a: any[]) => getPosition(...a),
  getVaultLimits: async (asset: any) => asset.onchainLimits,
}))
vi.mock('@/lib/contract-events', () => ({
  findOpenEvent: (...a: any[]) => findOpenEvent(...a),
}))
vi.mock('@/lib/quote-policy', () => ({
  reservedOpenPrice: (...a: any[]) => reservedOpenPrice(...a),
  markReservationIndexed: (...a: any[]) => markReservationIndexed(...(a as [])),
}))
// Present only to prove it is never consulted: the feed at index time is not
// the price at open.
vi.mock('@/lib/spot', () => ({ getSpot: (...a: any[]) => getSpot(...(a as [])) }))
vi.mock('@/lib/db-queries', () => ({
  logTransaction: (...a: any[]) => logTransaction(...a),
}))
vi.mock('@/lib/idempotency', () => ({
  reserveAction: (...a: any[]) => reserveAction(...a),
  releaseAction: async () => {},
  confirmAction: async () => {},
}))

let deposit: typeof import('@/app/api/vault/deposit/route')

beforeAll(async () => {
  // In-process limits only: the durable store is not what is under test.
  delete process.env.DATABASE_URL
  process.env.NEXT_PUBLIC_VAULT_CONTRACT = XLM_VAULT
  deposit = await import('@/app/api/vault/deposit/route')
})

const openedAt = Date.now() - 3 * DAY
const expiry = new Date(openedAt + 10 * DAY)

beforeEach(() => {
  getPosition.mockReset()
  findOpenEvent.mockReset()
  reservedOpenPrice.mockReset()
  markReservationIndexed.mockClear()
  logTransaction.mockClear()
  reserveAction.mockClear()
  getSpot.mockClear()
  getPosition.mockResolvedValue({
    id: 7,
    owner: OWNER,
    side: 'call',
    collateral: 10_000,
    strike: 0.3,
    expiry,
    premium: 25,
    settled: false,
    outcome: 'open',
  })
  findOpenEvent.mockResolvedValue({ at: openedAt })
  reservedOpenPrice.mockResolvedValue(0.26)
})

let ipSeq = 0
const nextIp = () => `198.51.100.${++ipSeq}`

const post = (body: unknown, ip = nextIp()) =>
  deposit.POST(
    new Request('http://t/api/vault/deposit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )

const body = (extra: object = {}) => ({
  address: OWNER,
  txHash: OPEN_TX,
  positionId: 7,
  type: 'call',
  collateralAmount: 10_000,
  strikePrice: 0.3,
  daysToExpiry: 999,
  ...extra,
})

describe('the open transaction is the ledger s, checked before anything is reserved', () => {
  it('refuses a hash that is not a transaction hash, before reading the chain', async () => {
    const res = await post(body({ txHash: 'abc123' }))
    expect(res.status).toBe(400)
    expect(getPosition).not.toHaveBeenCalled()
  })

  it('refuses a hash that did not open this position, and reserves nothing', async () => {
    findOpenEvent.mockResolvedValue(null)
    const res = await post(body())

    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('open_mismatch')
    expect(findOpenEvent).toHaveBeenCalledWith(XLM_VAULT, 7, OPEN_TX)
    // The point: a stranger with a junk hash cannot claim the replay key and
    // freeze the owner's position under it.
    expect(reserveAction).not.toHaveBeenCalled()
    expect(logTransaction).not.toHaveBeenCalled()
  })

  it('answers 503 when the ledger cannot be read, and reserves nothing', async () => {
    findOpenEvent.mockRejectedValue(new Error('soroban rpc: 503'))
    const res = await post(body())

    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('open_unverified')
    expect(reserveAction).not.toHaveBeenCalled()
  })

  it('answers 503 when the reservations cannot be read, and reserves nothing', async () => {
    reservedOpenPrice.mockRejectedValue(new Error('connect ECONNREFUSED'))
    const res = await post(body())

    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('open_unpriced')
    expect(reserveAction).not.toHaveBeenCalled()
  })
})

describe('a call is valued at the quote that opened it, not at index time', () => {
  it('records the reserved spot, the ledger s open time and the on-chain tenor', async () => {
    const res = await post(body())
    expect(res.status).toBe(200)

    expect(reservedOpenPrice).toHaveBeenCalledWith(
      expect.objectContaining({
        address: OWNER,
        underlying: 'XLM',
        type: 'call',
        collateral: 10_000,
        strike: 0.3,
        expiry,
        openedAt,
      }),
    )
    expect(getSpot).not.toHaveBeenCalled()

    const row = logTransaction.mock.calls[0][0]
    expect(row.txHash).toBe(OPEN_TX)
    expect(row.metadata.spotAtOpen).toBe(0.26)
    // Ten days from the ledger's open, not the 999 the body claimed.
    expect(row.metadata.daysToExpiry).toBe(10)
    // APR over the term from open, against the reserved price.
    const expected = (25 / (10_000 * 0.26)) * (365 / 10) * 100
    expect(row.metadata.apr).toBeCloseTo(expected, 6)
    expect(markReservationIndexed).toHaveBeenCalledTimes(1)
  })

  it('records an unpriced call as unknown and keeps its reservation counting', async () => {
    reservedOpenPrice.mockResolvedValue(null)
    const res = await post(body())
    expect(res.status).toBe(200)

    const row = logTransaction.mock.calls[0][0]
    expect(row.metadata.spotAtOpen).toBeUndefined()
    expect(row.metadata.apr).toBeUndefined()
    // The row adds nothing to a USD sum, so the reservation must not be
    // handed over to it — the handoff may overstate, never understate.
    expect(markReservationIndexed).not.toHaveBeenCalled()
  })

  it('hands a put s reservation over without a price', async () => {
    getPosition.mockResolvedValue({
      id: 7,
      owner: OWNER,
      side: 'put',
      collateral: 1_000,
      strike: 0.2,
      expiry,
      premium: 5,
      settled: false,
      outcome: 'open',
    })
    const res = await post(body({ type: 'put', collateralAmount: 1_000 }))
    expect(res.status).toBe(200)
    expect(reservedOpenPrice).not.toHaveBeenCalled()
    expect(markReservationIndexed).toHaveBeenCalledTimes(1)
  })
})

describe('a stranger cannot spend the owner s budget', () => {
  it('limits per client, so another client naming the owner is not refused', async () => {
    getPosition.mockRejectedValue(new Error('no such position'))
    const attacker = '203.0.113.50'
    let last = 0
    for (let i = 0; i < 31; i++) last = (await post(body({ positionId: 9_000 + i }), attacker)).status
    expect(last).toBe(429)

    getPosition.mockReset()
    getPosition.mockResolvedValue({
      id: 7, owner: OWNER, side: 'call', collateral: 10_000, strike: 0.3,
      expiry, premium: 25, settled: false, outcome: 'open',
    })
    const res = await post(body(), '203.0.113.51')
    expect(res.status).toBe(200)
  })
})

describe('the body is read with a cap', () => {
  it('answers 413 to an oversized body', async () => {
    const res = await post(JSON.stringify({ ...body(), pad: 'x'.repeat(70 * 1024) }))
    expect(res.status).toBe(413)
    expect(getPosition).not.toHaveBeenCalled()
  })

  it('answers 400 to a body that is not JSON', async () => {
    const res = await post('not json')
    expect(res.status).toBe(400)
  })
})
