import { beforeEach, describe, expect, it, vi } from 'vitest'

// Lapsed reservations the chain could not resolve.
// ================================================
// Kept pending on purpose when positions cannot be read — and counted against
// writers while they are. The check makes that visible: how many, under how
// many wallets, how much room they hold, since when.

const queries: { sql: string; params: any[] }[] = []
let row: any = { count: 0, owners: 0, books: [], notional_usd: 0, oldest: null }
let queryError: Error | null = null

vi.mock('@/lib/db', () => ({
  ensureSchema: async () => {},
  getPool: () => ({
    query: async (sql: string, params: any[] = []) => {
      queries.push({ sql, params })
      if (queryError) throw queryError
      return { rows: [row] }
    },
  }),
}))

const { checkLapsedReservations, lapsedReservationsAlert } = await import('../monitor/lapsed-reservations')

beforeEach(() => {
  queries.length = 0
  row = { count: 0, owners: 0, books: [], notional_usd: 0, oldest: null }
  queryError = null
})

describe('checkLapsedReservations', () => {
  it('is quiet when every lapsed reservation was resolved', async () => {
    expect(await checkLapsedReservations()).toBeNull()
  })

  it('says how many, under how many wallets, how much and since when', async () => {
    row = { count: 7, owners: 3, books: ['XLM', 'BTC'], notional_usd: 1234.5, oldest: new Date('2026-11-25T08:00:00Z') }
    const alert = await checkLapsedReservations()
    expect(alert?.severity).toBe('warning')
    expect(alert?.message).toContain('7 quote reservation(s) under 3 wallet(s)')
    expect(alert?.message).toContain('2026-11-25T08:00:00.000Z')
    expect(alert?.message).toContain('$1235')
    expect(alert?.fields?.find((f) => f.label === 'books')?.value).toBe('BTC, XLM')
  })

  it('counts only pending reservations well past their lapse, not ones the next sweep will take', async () => {
    await checkLapsedReservations()
    const [q] = queries
    expect(q.sql).toContain(`state = 'pending'`)
    expect(q.sql).toContain('valid_until < now() - make_interval(mins => $1)')
    expect(q.params).toEqual([30])
  })

  it('is critical when the reservations cannot be read, rather than quiet', async () => {
    queryError = new Error('too many connections')
    const alert = await checkLapsedReservations()
    expect(alert?.severity).toBe('critical')
    expect(alert?.message).toContain('too many connections')
  })
})

describe('lapsedReservationsAlert', () => {
  it('is null for none', () => {
    expect(lapsedReservationsAlert({ count: 0, owners: 0, books: [], notionalUsd: 0, oldest: null })).toBeNull()
  })
})
