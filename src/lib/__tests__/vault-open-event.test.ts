import { describe, it, expect, beforeEach, vi } from 'vitest'
import { StrKey, nativeToScVal } from '@stellar/stellar-sdk'

// findOpenEvent: is this hash the transaction that opened this position?
//
// Read off the ledger itself — the transaction, and the `deposit` event it
// emitted for this instance and id. "No" and "cannot say right now" are
// different answers, because the indexer refuses the first and retries the
// second.

const VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x11))
const OTHER_VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x22))
const HASH = 'cd'.repeat(32)
const CLOSED_AT = '2026-10-09T12:00:00Z'

const rpc = {
  getTransaction: vi.fn(),
  getEvents: vi.fn(),
}

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>()
  class Server {
    getTransaction(hash: string) {
      return rpc.getTransaction(hash)
    }
    getEvents(req: unknown) {
      return rpc.getEvents(req)
    }
  }
  return { ...actual, rpc: { ...actual.rpc, Server } }
})

const { findOpenEvent } = await import('../contract-events')

const depositEvent = (over: { contractId?: string; id?: number; txHash?: string } = {}) => ({
  ledger: 500,
  ledgerClosedAt: CLOSED_AT,
  contractId: { contractId: () => over.contractId ?? VAULT },
  txHash: over.txHash ?? HASH,
  topic: [
    nativeToScVal('deposit', { type: 'symbol' }),
    nativeToScVal(BigInt(over.id ?? 7), { type: 'u64' }),
  ],
  value: nativeToScVal([
    nativeToScVal(StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x66)), { type: 'address' }),
    nativeToScVal(100_0000000n, { type: 'i128' }),
    nativeToScVal(30_000_000_000_000n, { type: 'i128' }),
    nativeToScVal(1_760_000_000n, { type: 'u64' }),
    nativeToScVal(1_0000000n, { type: 'i128' }),
    nativeToScVal(0, { type: 'u32' }),
  ]),
})

beforeEach(() => {
  rpc.getTransaction.mockReset()
  rpc.getEvents.mockReset()
  rpc.getTransaction.mockResolvedValue({ status: 'SUCCESS', ledger: 500 })
  rpc.getEvents.mockResolvedValue({ events: [depositEvent()], latestLedger: 600 })
})

describe('findOpenEvent', () => {
  it('answers with the ledger close time of the matching deposit event', async () => {
    expect(await findOpenEvent(VAULT, 7, HASH)).toEqual({ at: Date.parse(CLOSED_AT) })
    // Scanned from the transaction's own ledger, filtered to this event.
    const req = rpc.getEvents.mock.calls[0][0]
    expect(req.startLedger).toBe(500)
    expect(req.filters[0].topics[0]).toHaveLength(2)
  })

  it('matches the hash regardless of case', async () => {
    expect(await findOpenEvent(VAULT, 7, HASH.toUpperCase())).not.toBeNull()
    expect(rpc.getTransaction).toHaveBeenCalledWith(HASH)
  })

  it('refuses something that is not a hash without asking the RPC', async () => {
    expect(await findOpenEvent(VAULT, 7, 'not-a-hash')).toBeNull()
    expect(rpc.getTransaction).not.toHaveBeenCalled()
  })

  it('refuses a transaction the RPC does not know, or that failed', async () => {
    rpc.getTransaction.mockResolvedValue({ status: 'NOT_FOUND' })
    expect(await findOpenEvent(VAULT, 7, HASH)).toBeNull()
    rpc.getTransaction.mockResolvedValue({ status: 'FAILED', ledger: 500 })
    expect(await findOpenEvent(VAULT, 7, HASH)).toBeNull()
  })

  it('refuses a transaction that did not open this instance s position', async () => {
    // Another instance's #7, in the same transaction.
    rpc.getEvents.mockResolvedValue({ events: [depositEvent({ contractId: OTHER_VAULT })], latestLedger: 600 })
    expect(await findOpenEvent(VAULT, 7, HASH)).toBeNull()

    // This instance's #7, opened by some other transaction: a real hash of
    // the caller's, just not the one that opened it.
    rpc.getEvents.mockResolvedValue({ events: [depositEvent({ txHash: 'ef'.repeat(32) })], latestLedger: 600 })
    expect(await findOpenEvent(VAULT, 7, HASH)).toBeNull()

    rpc.getEvents.mockResolvedValue({ events: [depositEvent({ id: 8 })], latestLedger: 600 })
    expect(await findOpenEvent(VAULT, 7, HASH)).toBeNull()
  })

  it('throws when the RPC cannot be read, so the caller can retry', async () => {
    rpc.getTransaction.mockRejectedValue(new Error('soroban rpc: 503'))
    await expect(findOpenEvent(VAULT, 7, HASH)).rejects.toThrow(/503/)

    rpc.getTransaction.mockResolvedValue({ status: 'SUCCESS', ledger: 500 })
    rpc.getEvents.mockRejectedValue(new Error('getEvents: 429'))
    await expect(findOpenEvent(VAULT, 7, HASH)).rejects.toThrow(/429/)
  })
})
