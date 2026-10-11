import { describe, it, expect, beforeEach, vi } from 'vitest'
import { XLM } from '../assets'

// The book a premium is haircut against, whoever reported it.
//
// Indexed deposit rows exist only for positions whose writer's client called
// the indexer. A writer who skips that call used to leave the book looking
// emptier than it was — a lower utilization, a richer premium, and a capacity
// alert that never fired. The contract's own per-expiry exposure is now read
// beside them, and the larger of the two is the book.

let indexed = { call: 0, put: 0 }
let chain = { call: 0, put: 0 }
let chainDown = false
const exposureReads = vi.fn()

vi.mock('@/lib/db', () => ({
  ensureSchema: async () => {},
  getPool: () => ({
    query: async (_text: string, params: unknown[]) => ({
      rows: ((params[0] as string[]) ?? []).map((k) => ({
        date_key: k,
        call_underlying: indexed.call,
        put_usd: indexed.put,
      })),
    }),
  }),
}))
vi.mock('@/lib/vault-contract', () => ({
  getExposure: async (side: 'call' | 'put', expiry: Date) => {
    exposureReads(side, expiry)
    if (chainDown) throw new Error('soroban rpc: 503')
    return chain[side]
  },
}))

const state = await import('../vault-state')
const { upcomingExpiryDates } = await import('../expiries')

const front = () => upcomingExpiryDates(new Date(), XLM.expiry)[0].toISOString()
const half = () => state.callEpochCap(XLM) / 2

beforeEach(() => {
  state.resetChainExposureCache()
  exposureReads.mockClear()
  indexed = { call: 0, put: 0 }
  chain = { call: 0, put: 0 }
  chainDown = false
})

describe('utilization counts what the contract holds', () => {
  it('reads a book that exists only on chain the same as an indexed one', async () => {
    indexed = { call: half(), put: 0 }
    const fromRows = await state.expiryUtilizationFor('call', front(), XLM)

    state.resetChainExposureCache()
    indexed = { call: 0, put: 0 }
    chain = { call: half(), put: 0 }
    const fromChain = await state.expiryUtilizationFor('call', front(), XLM)

    expect(fromRows).toBeGreaterThan(0)
    expect(fromChain).toBe(fromRows)
  })

  it('takes the larger record per bucket, so neither can pull the other down', async () => {
    indexed = { call: half(), put: 100 }
    chain = { call: half() / 2, put: 500 }
    const buckets = await state.computeOpenBuckets(new Date(), XLM)
    for (const b of buckets) {
      expect(b.callUnderlying).toBe(half())
      expect(b.putUsd).toBe(500)
    }
  })

  it('reads every open expiry, both sides, off the book s own schedule', async () => {
    const dates = upcomingExpiryDates(new Date(), XLM.expiry)
    await state.computeOpenBuckets(new Date(), XLM)
    expect(exposureReads).toHaveBeenCalledTimes(dates.length * 2)
    for (const d of dates) {
      expect(exposureReads).toHaveBeenCalledWith('call', d)
      expect(exposureReads).toHaveBeenCalledWith('put', d)
    }
  })

  it('assumes a nearly full pool when the instance cannot be read', async () => {
    chainDown = true
    expect(await state.expiryUtilizationFor('call', front(), XLM)).toBe(0.98)
    await expect(state.computeOpenBuckets(new Date(), XLM)).rejects.toThrow(/503/)
  })

  it('does not reuse a failed read', async () => {
    chainDown = true
    await state.expiryUtilizationFor('call', front(), XLM)
    chainDown = false
    expect(await state.expiryUtilizationFor('call', front(), XLM)).toBeLessThan(0.98)
  })
})
