import { describe, it, expect, vi } from 'vitest'
import { COLLATERAL_USD_SQL } from '../db'

// The leaderboard's volume column, and the admin panel's, are the two places
// this application still adds one writer's deposit to another's. Both are
// printed behind a dollar sign, so both have to be dollars.
//
// The arithmetic itself runs in Postgres and is verified against a real
// database, not here. What these pin is that the arithmetic exists at all —
// that neither total has quietly gone back to summing the escrowed amount,
// which is a quantity of lumens or of bitcoin depending on the row.

describe('a deposit is valued before it is totalled', () => {
  it('takes a put at its face, because cash is already dollars', () => {
    expect(COLLATERAL_USD_SQL).toMatch(/when t\.subtype = 'put' then t\.amount/)
  })

  it('prices a call off the spot the deposit route recorded at open', () => {
    expect(COLLATERAL_USD_SQL).toMatch(/t\.amount \* \(t\.metadata->>'spotAtOpen'\)::numeric/)
  })

  it('leaves an unpriced call out rather than counting its units as dollars', () => {
    // No `else` branch: the case falls through to null, and null sums to
    // nothing. A row whose price was never recorded is missing from the
    // total, which is what unknown means here.
    expect(COLLATERAL_USD_SQL).not.toMatch(/\belse\b/)
    expect(COLLATERAL_USD_SQL).toMatch(/jsonb_typeof\(t\.metadata->'spotAtOpen'\) = 'number'/)
  })

  it('counts nothing that is not a vault deposit', () => {
    expect(COLLATERAL_USD_SQL).toMatch(/when t\.type != 'deposit' then null/)
    expect(COLLATERAL_USD_SQL).toMatch(/when t\.subtype = 'swap' then null/)
  })
})

describe('the admin total is valued the same way', () => {
  it('sums the shared expression, not the raw amount', async () => {
    const queries: string[] = []
    vi.doMock('@/lib/db', async () => {
      const actual = await vi.importActual<typeof import('../db')>('../db')
      return {
        COLLATERAL_USD_SQL: actual.COLLATERAL_USD_SQL,
        ensureSchema: async () => {},
        getPool: () => ({
          query: async (text: string) => {
            queries.push(text)
            return { rows: [{ count: '0', total_deposited: '0', total_premium: '0' }] }
          },
        }),
      }
    })

    const { getAdminStats } = await import('../db-queries')
    await getAdminStats()

    const volumes = queries.find((t) => t.includes('total_deposited'))
    expect(volumes).toContain("'spotAtOpen'")
    expect(volumes).not.toMatch(/sum\(case when type = 'deposit' then amount end\)/)

    vi.doUnmock('@/lib/db')
  })
})
