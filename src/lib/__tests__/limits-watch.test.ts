import { describe, it, expect, beforeEach, vi } from 'vitest'
import { StrKey, nativeToScVal, xdr } from '@stellar/stellar-sdk'

// The watch exists for the change the polling cannot see: a cap raised and
// restored between two readings. So the tests feed it events, not readings,
// and check what it says about each shape — a change back to the declared
// values, a change away from them, two in one interval, and an instance
// nobody declared.

const XLM_VAULT = process.env.NEXT_PUBLIC_VAULT_CONTRACT!

let scanned: { changes: any[]; cursor?: string } = { changes: [] }
let scanError: Error | null = null
const scanCalls: (string | undefined)[] = []
let stored: string | undefined
const resetLimitsCache = vi.fn()

vi.mock('@/lib/contract-events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../contract-events')>()),
  scanLimitsChanges: async (cursor?: string) => {
    scanCalls.push(cursor)
    if (scanError) throw scanError
    return scanned
  },
}))
vi.mock('@/lib/vault-limits', () => ({ resetLimitsCache }))
vi.mock('@/lib/db', () => ({
  ensureSchema: async () => {},
  getPool: () => ({
    query: async (sql: string, params: any[]) => {
      if (sql.includes('select cursor')) return { rows: stored ? [{ cursor: stored }] : [] }
      stored = params[1]
      return { rows: [] }
    },
  }),
}))

const { limitsChangeAlert, checkLimitsEvents } = await import('../monitor/limits-watch')
const { parseLimitsEvent } = await import('../contract-events')
const { underlying } = await import('../assets')

const xlm = underlying('XLM')
const declared = xlm.onchainLimits

function change(over: Partial<Record<'maxPositionCall' | 'maxPositionPut' | 'maxPremiumBps', number>> = {}) {
  return {
    contractId: XLM_VAULT,
    ledger: 1000,
    at: '2026-10-06T00:00:00Z',
    txHash: 'abc',
    maxPositionCall: declared.maxPositionCall,
    maxPositionPut: declared.maxPositionPut,
    maxPremiumBps: declared.maxPremiumBps,
    ...over,
  }
}

beforeEach(() => {
  scanned = { changes: [] }
  scanCalls.length = 0
  scanError = null
  stored = undefined
  resetLimitsCache.mockClear()
})

describe('limitsChangeAlert', () => {
  it('is quiet when nothing changed', () => {
    expect(limitsChangeAlert([], [xlm])).toBeNull()
  })

  it('warns on a change to the declared values', () => {
    const a = limitsChangeAlert([change()], [xlm])
    expect(a?.severity).toBe('warning')
    expect(a?.message).toContain('set to the declared values')
  })

  it('is critical when a cap moves away from the declaration', () => {
    const a = limitsChangeAlert([change({ maxPositionCall: declared.maxPositionCall * 10 })], [xlm])
    expect(a?.severity).toBe('critical')
    expect(a?.message).toContain(`call position cap ${declared.maxPositionCall} → ${declared.maxPositionCall * 10}`)
  })

  it('reports a raise and its revert, not only where it ended', () => {
    const raised = change({ maxPremiumBps: 10_000 })
    const restored = { ...change(), ledger: 1005 }
    const a = limitsChangeAlert([raised, restored], [xlm])
    // The end state is clean. The alert is not, because the middle was not.
    expect(a?.severity).toBe('critical')
    expect(a?.message).toContain('raise-and-revert')
    expect(a?.fields).toHaveLength(2)
  })

  it('is critical for an instance no book declares', () => {
    const stranger = StrKey.encodeContract(Buffer.alloc(32, 0x99))
    const a = limitsChangeAlert([{ ...change(), contractId: stranger }], [xlm])
    expect(a?.severity).toBe('critical')
  })
})

describe('checkLimitsEvents', () => {
  it('resumes from the stored cursor and advances it', async () => {
    stored = 'c1'
    scanned = { changes: [], cursor: 'c2' }
    expect(await checkLimitsEvents()).toBeNull()
    expect(scanCalls).toEqual(['c1'])
    expect(stored).toBe('c2')
    expect(resetLimitsCache).not.toHaveBeenCalled()
  })

  it('makes the reconciliation re-read when a limit moved', async () => {
    scanned = { changes: [change({ maxPositionPut: 1 })], cursor: 'c3' }
    const a = await checkLimitsEvents()
    expect(a?.severity).toBe('critical')
    expect(resetLimitsCache).toHaveBeenCalledOnce()
  })

  it('turns a failed scan into an alert rather than silence', async () => {
    stored = 'old'
    scanError = new Error('cursor out of range')
    const a = await checkLimitsEvents()
    expect(a?.severity).toBe('critical')
    expect(a?.message).toContain('cursor out of range')
    expect(stored).toBe('old')
  })
})

describe('per-expiry caps on a v5 event', () => {
  it('flag a change away from the declared cap, and are skipped when absent', () => {
    const v5 = { ...change(), maxExpiryCall: declared.maxExpiryCall * 2, maxExpiryPut: declared.maxExpiryPut }
    expect(limitsChangeAlert([v5], [xlm])!.severity).toBe('critical')
    expect(limitsChangeAlert([change()], [xlm])!.severity).toBe('warning')
  })
})

describe('parseLimitsEvent', () => {
  it('reads the three values the contract publishes', () => {
    const raw: any = {
      topic: [nativeToScVal('limits', { type: 'symbol' })],
      value: xdr.ScVal.scvVec([
        nativeToScVal(500_000_000n, { type: 'i128' }),
        nativeToScVal(15_000_000_000n, { type: 'i128' }),
        nativeToScVal(2000, { type: 'u32' }),
      ]),
      contractId: { contractId: () => XLM_VAULT },
      ledger: 7,
      ledgerClosedAt: '2026-10-06T00:00:00Z',
      txHash: 'h',
    }
    expect(parseLimitsEvent(raw)).toMatchObject({
      contractId: XLM_VAULT,
      maxPositionCall: 50,
      maxPositionPut: 1500,
      maxPremiumBps: 2000,
    })
  })

  it('reads the per-expiry caps a v5 instance appends, and leaves them unset on v4', () => {
    const raw: any = {
      topic: [nativeToScVal('limits', { type: 'symbol' })],
      value: xdr.ScVal.scvVec([
        nativeToScVal(500_000_000n, { type: 'i128' }),
        nativeToScVal(15_000_000_000n, { type: 'i128' }),
        nativeToScVal(2000, { type: 'u32' }),
        nativeToScVal(2_500_000_000n, { type: 'i128' }),
        nativeToScVal(30_000_000_000n, { type: 'i128' }),
      ]),
      contractId: { contractId: () => XLM_VAULT },
      ledger: 8,
      ledgerClosedAt: '2026-10-06T00:00:00Z',
    }
    expect(parseLimitsEvent(raw)).toMatchObject({ maxExpiryCall: 250, maxExpiryPut: 3000 })

    raw.value = xdr.ScVal.scvVec(raw.value.vec().slice(0, 3))
    const v4 = parseLimitsEvent(raw)!
    expect(v4.maxExpiryCall).toBeUndefined()
    expect(v4.maxPositionCall).toBe(50)
  })

  it('ignores any other event', () => {
    const raw: any = {
      topic: [nativeToScVal('settle', { type: 'symbol' })],
      value: xdr.ScVal.scvVec([]),
      contractId: { contractId: () => XLM_VAULT },
    }
    expect(parseLimitsEvent(raw)).toBeNull()
  })
})
