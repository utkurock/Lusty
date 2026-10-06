import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'

// A payout Horizon could not confirm is not a payout that failed.
// ===============================================================
// The swap and the bridge pay out of the distributor against a payment the
// caller already made, behind a replay guard on that payment's hash. Releasing
// the guard on a timeout let the same funding hash be paid twice: the first
// payout landed after Horizon gave up on it, and the retry paid again. These
// tests drive the bridge route itself with Horizon down in each way it goes
// down, and read what happened to the guard.

import { rejectedByNetwork, submitPayout } from '../payout-submit'

const DISTRIBUTOR = Keypair.random()
const WRITER = Keypair.random().publicKey()
const FUNDING = 'a'.repeat(64)

process.env.LUSD_DISTRIBUTOR_SECRET = DISTRIBUTOR.secret()
process.env.NEXT_PUBLIC_LUSD_ISSUER = Keypair.random().publicKey()

const guard = {
  reserveAction: vi.fn(async () => ({ reserved: true, alreadyProcessed: false })),
  releaseAction: vi.fn(async () => {}),
  confirmAction: vi.fn(async () => {}),
  holdUnconfirmed: vi.fn(async () => {}),
}
vi.mock('@/lib/idempotency', () => guard)
vi.mock('@/lib/db', () => ({ ensureSchema: async () => {}, getPool: () => ({ query: async () => ({ rows: [] }) }) }))
vi.mock('@/lib/db-queries', () => ({ logTransaction: vi.fn(async () => {}) }))
vi.mock('@/lib/rate-limit', () => ({ durableRateLimit: async () => ({ ok: true }) }))
vi.mock('@/lib/anchor/bridge-proof', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/anchor/bridge-proof')>()
  return { ...actual, verifyBridgeFunding: () => ({ ok: true, paidAmount: 10 }) }
})

// Horizon, reduced to what the bridge reads and the one call that matters.
const submitTransaction = vi.fn()
vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>()
  const { LUSD_CODE, LUSD_ISSUER } = await import('@/lib/lusd')
  class Server {
    transactions() {
      return { transaction: () => ({ call: async () => ({ successful: true }) }) }
    }
    operations() {
      return { forTransaction: () => ({ call: async () => ({ records: [] }) }) }
    }
    async loadAccount(id: string) {
      const acct = new actual.Account(id, '100')
      return Object.assign(acct, {
        balances: [{ asset_code: LUSD_CODE, asset_issuer: LUSD_ISSUER, balance: '1000' }],
      })
    }
    submitTransaction(tx: unknown) {
      return submitTransaction(tx)
    }
  }
  return { ...actual, Horizon: { ...actual.Horizon, Server } }
})

const { POST } = await import('@/app/api/anchor/bridge/route')

const cross = () =>
  POST(
    new Request('http://x/api/anchor/bridge', {
      method: 'POST',
      body: JSON.stringify({
        address: WRITER,
        txHash: FUNDING,
        direction: 'anchor_to_cash',
        sourceAmount: 10,
      }),
    }),
  )

const horizonError = (status: number, data: unknown = {}) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  })

beforeEach(() => {
  submitTransaction.mockReset()
  for (const f of Object.values(guard)) f.mockClear()
})

describe('what a submit failure means', () => {
  it('reads only a 400 with result codes as the network saying no', () => {
    expect(rejectedByNetwork(horizonError(400, { extras: { result_codes: { transaction: 'tx_failed' } } }))).toBe(true)
    expect(rejectedByNetwork(horizonError(504))).toBe(false)
    expect(rejectedByNetwork(horizonError(503))).toBe(false)
    // A 400 without result codes is Horizon refusing the request, not the
    // network ruling on the transaction.
    expect(rejectedByNetwork(horizonError(400))).toBe(false)
    expect(rejectedByNetwork(new Error('socket hang up'))).toBe(false)
    expect(rejectedByNetwork(undefined)).toBe(false)
  })

  it('keeps the hash of a payout whose outcome is open', async () => {
    const out = await submitPayout(() => Promise.reject(horizonError(504)), 'b'.repeat(64))
    expect(out).toMatchObject({ kind: 'unknown', hash: 'b'.repeat(64) })
  })
})

describe('the bridge with Horizon down', () => {
  it('keeps the replay guard when the payout times out, so a retry cannot pay again', async () => {
    submitTransaction.mockRejectedValue(horizonError(504, { title: 'Timeout' }))

    const res = await cross()
    const body = await res.json()

    expect(res.status).toBe(502)
    expect(body.code).toBe('payout_unconfirmed')
    expect(body.payoutHash).toMatch(/^[0-9a-f]{64}$/)
    expect(guard.releaseAction).not.toHaveBeenCalled()
    expect(guard.holdUnconfirmed).toHaveBeenCalledWith('swap', FUNDING, body.payoutHash)
    expect(guard.confirmAction).not.toHaveBeenCalled()
  })

  it('keeps it when the connection drops with no answer at all', async () => {
    submitTransaction.mockRejectedValue(new Error('socket hang up'))

    const res = await cross()

    expect(res.status).toBe(502)
    expect(guard.releaseAction).not.toHaveBeenCalled()
  })

  it('releases it when the network refused the payout, so the writer can retry', async () => {
    submitTransaction.mockRejectedValue(
      horizonError(400, { extras: { result_codes: { transaction: 'tx_bad_seq' } } }),
    )

    const res = await cross()

    expect(res.status).toBe(500)
    expect(guard.releaseAction).toHaveBeenCalledWith('swap', FUNDING)
    expect(guard.holdUnconfirmed).not.toHaveBeenCalled()
  })

  it('confirms a payout that landed', async () => {
    submitTransaction.mockResolvedValue({ hash: 'c'.repeat(64) })

    const res = await cross()

    expect(res.status).toBe(200)
    expect(guard.confirmAction).toHaveBeenCalledWith('swap', FUNDING, 'c'.repeat(64))
    expect(guard.releaseAction).not.toHaveBeenCalled()
  })
})
