import { describe, it, expect, beforeEach, vi } from 'vitest'
import { XLM, BTC } from '../assets'

// A stand-in book: rows keyed by the underlying the query asks for, so the
// only thing that decides what a caller sees is the parameter it passed.
const BOOKS: Record<string, { call: number; put: number }> = {
  XLM: { call: 0, put: 0 },
  BTC: { call: 0, put: 0 },
}

const queries: { text: string; params: unknown[] }[] = []

vi.mock('@/lib/db', () => ({
  ensureSchema: async () => {},
  getPool: () => ({
    query: async (text: string, params: unknown[]) => {
      queries.push({ text, params })
      const underlying = String(params.find((p) => p === 'XLM' || p === 'BTC') ?? '')
      const book = BOOKS[underlying] ?? { call: 0, put: 0 }
      if (text.includes('date_key')) {
        const keys = (params[0] as string[]) ?? []
        return {
          rows: keys.map((k) => ({ date_key: k, call_xlm: book.call, put_usd: book.put })),
        }
      }
      return { rows: [{ call_xlm: book.call, put_lusd: book.put }] }
    },
  }),
}))

const state = await import('../vault-state')

beforeEach(() => {
  queries.length = 0
  BOOKS.XLM = { call: 0, put: 0 }
  BOOKS.BTC = { call: 0, put: 0 }
})

const anExpiry = () => new Date(Date.now() + 7 * 86_400_000).toISOString()

describe('every read is scoped to one underlying', () => {
  it('asks the database for the asset it was given', async () => {
    await state.computeOpenBuckets(new Date(), BTC)
    await state.computeOpenExposure(BTC)

    expect(queries).toHaveLength(2)
    for (const q of queries) {
      expect(q.text).toMatch(/underlying = \$\d/)
      expect(q.params).toContain('BTC')
      expect(q.params).not.toContain('XLM')
    }
  })

  it('defaults to XLM, which is what every Tranche 1 caller meant', async () => {
    await state.computeOpenExposure()
    expect(queries[0].params).toContain('XLM')
  })
})

describe('filling one book leaves the other s haircut alone', () => {
  it('does not move XLM s utilization by a basis point when BTC fills up', async () => {
    const expiry = anExpiry()
    const before = await state.expiryUtilizationFor('call', expiry, XLM)

    // BTC sells its entire monthly capacity, several times over.
    BOOKS.BTC = { call: BTC.callMonthlyCap * 10, put: BTC.putMonthlyCapUsd * 10 }
    const after = await state.expiryUtilizationFor('call', expiry, XLM)

    expect(after).toBe(before)
  })

  it('still reads BTC s own fill as full', async () => {
    const expiry = anExpiry()
    BOOKS.BTC = { call: BTC.callMonthlyCap * 10, put: 0 }

    const btc = await state.expiryUtilizationFor('call', expiry, BTC)
    const xlm = await state.expiryUtilizationFor('call', expiry, XLM)

    expect(btc).toBeGreaterThan(xlm)
    expect(btc).toBeGreaterThan(0.5)
  })

  it('measures each fill against its own capacity, not a shared one', async () => {
    const expiry = anExpiry()
    // The same *fraction* of each asset's very different monthly budget.
    BOOKS.XLM = { call: XLM.callMonthlyCap / 2, put: 0 }
    BOOKS.BTC = { call: BTC.callMonthlyCap / 2, put: 0 }

    expect(XLM.callMonthlyCap).not.toBe(BTC.callMonthlyCap)
    expect(await state.expiryUtilizationFor('call', expiry, BTC)).toBe(
      await state.expiryUtilizationFor('call', expiry, XLM),
    )
  })

  it('caps each expiry off the asset s own monthly budget', () => {
    expect(state.callEpochCap(BTC)).toBe(BTC.callMonthlyCap / state.EPOCHS_PER_MONTH)
    expect(state.putEpochCap(XLM)).toBe(XLM.putMonthlyCapUsd / state.EPOCHS_PER_MONTH)
    expect(state.callEpochCap(BTC)).not.toBe(state.callEpochCap(XLM))
  })
})
