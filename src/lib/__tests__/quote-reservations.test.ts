import { describe, it, expect, vi, beforeEach } from 'vitest'

// The quoter's allowances used to read only the deposits a writer's own client
// chose to report. These are the rules for what it signed instead.

const calls: { sql: string; params: any[] }[] = []
let answer: (sql: string, params: any[]) => { rows: any[] } = () => ({ rows: [] })

vi.mock('../db', () => ({
  ensureSchema: async () => {},
  getPool: () => ({
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params })
      return answer(sql, params)
    },
  }),
}))

import {
  assertQuoteAllowed,
  reserveQuote,
  markReservationIndexed,
  PolicyRejection,
  type PolicyInput,
} from '../quote-policy'

const EXPIRY = '2026-10-16T08:00:00.000Z'

const input = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  address: 'GWRITER',
  underlying: 'XLM',
  type: 'call',
  collateralAmount: 100,
  notionalUsd: 25,
  strikePrice: 0.3,
  strikeBucketPct: 0.01,
  expiryIso: EXPIRY,
  maxUserNotionalUsd: 1000,
  strikeInventoryLimitUsd: 5000,
  maxUserEpochCallXlm: 1000,
  maxUserEpochPutUsd: 1000,
  ...over,
})

beforeEach(() => {
  calls.length = 0
  answer = () => ({ rows: [] })
})

describe('what was signed counts, reported or not', () => {
  it('refuses once signed-but-unreported notional fills the wallet allowance', async () => {
    answer = (sql) =>
      sql.includes('from quote_reservations') && sql.includes('user_notional')
        ? { rows: [{ user_notional: 990, epoch_call: 0, epoch_put: 0, strike_notional: 0 }] }
        : { rows: [] }

    await expect(assertQuoteAllowed(input())).rejects.toMatchObject({
      code: 'user_limit_exceeded',
    })
  })

  it('refuses once signed collateral fills the per-expiry allowance', async () => {
    answer = (sql) =>
      sql.includes('user_notional')
        ? { rows: [{ user_notional: 0, epoch_call: 950, epoch_put: 0, strike_notional: 0 }] }
        : { rows: [] }

    const err = await assertQuoteAllowed(input()).catch((e) => e)
    expect(err).toBeInstanceOf(PolicyRejection)
    expect(err.code).toBe('user_epoch_limit_exceeded')
  })

  it('counts signatures across wallets against the strike inventory', async () => {
    answer = (sql) =>
      sql.includes('user_notional')
        ? { rows: [{ user_notional: 0, epoch_call: 0, epoch_put: 0, strike_notional: 4990 }] }
        : { rows: [] }

    await expect(assertQuoteAllowed(input())).rejects.toMatchObject({
      code: 'strike_limit_exceeded',
    })
  })

  it('passes with nothing signed and nothing deposited', async () => {
    await expect(assertQuoteAllowed(input())).resolves.toBeUndefined()
  })
})

describe('a lapsed signature is settled against the chain', () => {
  const lapsedRow = (id: number) => ({
    id,
    subtype: 'call',
    collateral: 100,
    strike_price: 0.3,
    expiry_iso: EXPIRY,
  })

  it('marks one opened per matching position and the rest unused', async () => {
    answer = (sql) =>
      sql.includes("state = 'pending' and valid_until < now()")
        ? { rows: [lapsedRow(1), lapsedRow(2)] }
        : { rows: [] }
    const readPositions = vi.fn(async () => [
      { side: 'call' as const, collateral: 100, strike: 0.3, expiry: new Date(EXPIRY) },
    ])

    await assertQuoteAllowed(input({ readPositions }))

    const update = calls.find((c) => c.sql.includes('update quote_reservations'))!
    expect(update.params).toEqual([[1], [1, 2]])
  })

  it('does not let a position already accounted for open a second reservation', async () => {
    answer = (sql) =>
      sql.includes("state = 'pending' and valid_until < now()")
        ? { rows: [lapsedRow(2)] }
        : sql.includes("state in ('opened','indexed')")
          ? { rows: [lapsedRow(1)] }
          : { rows: [] }
    const readPositions = async () => [
      { side: 'call' as const, collateral: 100, strike: 0.3, expiry: new Date(EXPIRY) },
    ]

    await assertQuoteAllowed(input({ readPositions }))

    const update = calls.find((c) => c.sql.includes('update quote_reservations'))!
    expect(update.params).toEqual([[], [2]])
  })

  it('keeps them counting when the chain cannot be read', async () => {
    answer = (sql) =>
      sql.includes("state = 'pending' and valid_until < now()") ? { rows: [lapsedRow(1)] } : { rows: [] }
    const readPositions = async () => {
      throw new Error('soroban rpc: 503')
    }

    await assertQuoteAllowed(input({ readPositions }))
    expect(calls.some((c) => c.sql.includes('update quote_reservations'))).toBe(false)
  })

  it('does not read the chain when nothing has lapsed', async () => {
    const readPositions = vi.fn(async () => [])
    await assertQuoteAllowed(input({ readPositions }))
    expect(readPositions).not.toHaveBeenCalled()
  })
})

describe('reservation bookkeeping', () => {
  it('records the signed terms', async () => {
    const validUntil = new Date('2026-10-09T12:10:00Z')
    await reserveQuote({
      address: 'GWRITER',
      underlying: 'XLM',
      type: 'put',
      collateralAmount: 50,
      notionalUsd: 50,
      strikePrice: 0.2,
      expiryIso: EXPIRY,
      validUntil,
    })
    expect(calls[0].sql).toMatch(/insert into quote_reservations/)
    expect(calls[0].params).toEqual(['GWRITER', 'XLM', 'put', 50, 50, 0.2, EXPIRY, validUntil.toISOString()])
  })

  it('hands the matching reservation to its deposit row', async () => {
    answer = (sql) =>
      sql.includes("state <> 'indexed'")
        ? {
            rows: [
              { id: 7, collateral: 99, strike_price: 0.3, expiry_iso: EXPIRY },
              { id: 8, collateral: 100, strike_price: 0.3, expiry_iso: EXPIRY },
            ],
          }
        : { rows: [] }

    await markReservationIndexed({
      address: 'GWRITER',
      underlying: 'XLM',
      type: 'call',
      collateral: 100,
      strike: 0.3,
      expiry: new Date(EXPIRY),
    })
    const update = calls.find((c) => c.sql.includes("set state = 'indexed'"))!
    expect(update.params).toEqual([8])
  })
})
