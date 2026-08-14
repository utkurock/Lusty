import { describe, it, expect, vi, beforeEach } from 'vitest'

// What the retired rail owes, in the unit it owes it in.
// ======================================================
// The backlog figure is the input to a wind-down decision — pay it out, or
// announce a deadline and close the book — so the number has to mean what its
// name says. It did not: `transactions.amount` holds USD notional on a call
// row, and summing it under `callCollateralXlm` reported the debt at spot
// rather than in the collateral actually escrowed.
//
// Postgres is not in this suite, so the query itself is what gets asserted.
// That is the right level anyway: the bug was in the expression, not in the
// mapping around it, and a mocked pool that returns whatever it is told would
// have passed just as happily before the fix.

const query = vi.fn()

vi.mock('../db', () => ({
  getPool: () => ({ query }),
  ensureSchema: vi.fn(async () => {}),
}))

import { getLegacyClaimBacklog } from '../db-queries'

function sqlOf(call: number = 0): string {
  return query.mock.calls[call][0] as string
}

beforeEach(() => {
  vi.clearAllMocks()
  query.mockResolvedValue({ rows: [{ rows: 0, wallets: 0, call_xlm: 0, put_usd: 0 }] })
})

describe('getLegacyClaimBacklog', () => {
  it('totals the escrowed collateral, not the dollar notional beside it', async () => {
    await getLegacyClaimBacklog()
    const sql = sqlOf()

    expect(sql).toContain(`metadata->>'collateralAmount'`)
    // The regression itself: a bare sum over the amount column. Both legs read
    // through the coalesce now, so neither can reintroduce it quietly.
    expect(sql).not.toMatch(/sum\(\s*t\.amount\s*\)/)
    expect(sql.match(/collateralAmount/g)).toHaveLength(2)
  })

  it('keeps the two legs apart', async () => {
    // Call collateral is XLM and put collateral is cash. A single total would
    // be a number in no currency at all, so the query never produces one.
    await getLegacyClaimBacklog()
    const sql = sqlOf()
    expect(sql).toContain(`filter (where t.subtype = 'call')`)
    expect(sql).toContain(`filter (where t.subtype = 'put')`)
  })

  it('counts only rows the payout path would still act on', async () => {
    await getLegacyClaimBacklog()
    const sql = sqlOf()
    // Contract positions carry an id and settle on chain; claimed rows are
    // done. Either one included here would overstate the debt.
    expect(sql).toContain(`not (t.metadata ? 'positionId')`)
    expect(sql).toContain('pa.confirmed_at is null')
  })

  it('scopes to one wallet when asked, and to the whole book when not', async () => {
    await getLegacyClaimBacklog('GWRITER')
    expect(query.mock.calls[0][1]).toEqual(['GWRITER'])

    await getLegacyClaimBacklog()
    expect(query.mock.calls[1][1]).toEqual([null])
  })

  it('reports what the query returned', async () => {
    query.mockResolvedValue({
      rows: [{ rows: 12, wallets: 5, call_xlm: 4_200.5, put_usd: 310.25 }],
    })
    const b = await getLegacyClaimBacklog()
    expect(b).toEqual({
      rows: 12,
      wallets: 5,
      callCollateralXlm: 4_200.5,
      putCollateralUsd: 310.25,
    })
  })

  it('reads an empty result as zero owed rather than as undefined', async () => {
    query.mockResolvedValue({ rows: [] })
    expect(await getLegacyClaimBacklog()).toEqual({
      rows: 0,
      wallets: 0,
      callCollateralXlm: 0,
      putCollateralUsd: 0,
    })
  })
})
