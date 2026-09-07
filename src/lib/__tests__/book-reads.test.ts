import { describe, it, expect, beforeEach, vi } from 'vitest'
import { XLM, BTC } from '../assets'
import { settlementKey } from '../contract-events'
import { settlementPayout } from '../vault-contract'

// The write side has recorded which book a position belongs to since the
// underlying column landed. These are the reads: every one of them either
// narrows to a book or says on the row which book answered, and none of them
// adds one book's units to another's.

const ADDR = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST'

interface Row {
  tx_hash: string
  address: string
  subtype: 'call' | 'put'
  amount: string
  asset: string
  underlying: string | null
  premium_hash: string | null
  premium_amount: string
  metadata: Record<string, unknown>
  created_at: string
  settled: boolean
  payout_hash: string | null
}

function row(p: {
  hash: string
  subtype: 'call' | 'put'
  underlying: string | null
  asset: string
  collateral: number
  positionId: number
}): Row {
  return {
    tx_hash: p.hash,
    address: ADDR,
    subtype: p.subtype,
    amount: String(p.collateral),
    asset: p.asset,
    underlying: p.underlying,
    premium_hash: p.hash,
    premium_amount: '1',
    metadata: { collateralAmount: p.collateral, positionId: p.positionId },
    created_at: '2026-09-01T00:00:00.000Z',
    settled: false,
    payout_hash: null,
  }
}

// One BTC position beside one XLM position, both numbered #3 by their own
// instance, plus a Tranche 1 put as the migration left it — backfilled to
// 'XLM', which is the only book it could ever have been written in.
const ROWS: Row[] = [
  row({ hash: 'xlm-call', subtype: 'call', underlying: 'XLM', asset: 'XLM', collateral: 500_000, positionId: 3 }),
  row({ hash: 'btc-call', subtype: 'call', underlying: 'BTC', asset: 'BTC', collateral: 0.5, positionId: 3 }),
  row({ hash: 'legacy-put', subtype: 'put', underlying: 'XLM', asset: 'LUSD', collateral: 1_000, positionId: 1 }),
  // No book at all. The check constraint makes this unreachable for an
  // option, so it stands for the one gap the constraint cannot close: a row
  // inserted against a database that has the column and not yet the
  // constraint.
  row({ hash: 'orphan', subtype: 'call', underlying: null, asset: 'XLM', collateral: 7, positionId: 9 }),
]

const queries: { text: string; params: unknown[] }[] = []

vi.mock('@/lib/db', () => ({
  ensureSchema: async () => {},
  getPool: () => ({
    query: async (text: string, params: unknown[]) => {
      queries.push({ text, params })
      // The fake filters only when the SQL asked it to, so a read that
      // forgets its where clause fails here rather than passing on a
      // convenience the database would never have given it.
      const book = params.find((p) => p === 'XLM' || p === 'BTC')
      const rows = /underlying = \$\d/.test(text)
        ? ROWS.filter((r) => r.underlying === book)
        : ROWS
      return { rows }
    },
  }),
}))

const q = await import('../db-queries')

beforeEach(() => {
  queries.length = 0
})

const totalCollateral = (rows: { collateralAmount: number }[]) =>
  rows.reduce((a, r) => a + r.collateralAmount, 0)

describe('every position read says which book it came from', () => {
  it('carries the underlying on the row', async () => {
    const rows = await q.getPositionsForAddress(ADDR)
    expect(rows.map((r) => r.underlying)).toEqual(['XLM', 'BTC', 'XLM', 'XLM'])
  })

  it('shows a bookless row as XLM rather than as nothing', async () => {
    // The row-level default is for display only. It deliberately does not
    // reach the filter below: a scoped read asks the database, and a row the
    // database says belongs to no book is not evidence about this one. The
    // constraint is what keeps the two from disagreeing about a real row.
    const rows = await q.getPositionsForAddress(ADDR)
    expect(rows.find((r) => r.id === 'orphan')?.underlying).toBe('XLM')

    const xlm = await q.getPositionsForAddress(ADDR, XLM)
    expect(xlm.map((r) => r.id)).not.toContain('orphan')
  })

  it('narrows in SQL when a book is named, not afterwards', async () => {
    const rows = await q.getPositionsForAddress(ADDR, BTC)
    expect(queries[0].text).toMatch(/t\.underlying = \$2/)
    expect(queries[0].params).toEqual([ADDR, 'BTC'])
    expect(rows.map((r) => r.id)).toEqual(['btc-call'])
  })

  it('asks for every book when none is named — a list is not a total', async () => {
    await q.getPositionsForAddress(ADDR)
    expect(queries[0].text).not.toMatch(/underlying = \$/)
    expect(queries[0].params).toEqual([ADDR])
  })
})

describe('no total spans two books', () => {
  it('keeps BTC collateral out of the XLM total and back', async () => {
    const xlm = await q.getPositionsForAddress(ADDR, XLM)
    const btc = await q.getPositionsForAddress(ADDR, BTC)

    // 500,000 XLM of calls; the legacy put is XLM's book too.
    expect(totalCollateral(xlm)).toBe(501_000)
    expect(totalCollateral(btc)).toBe(0.5)

    // What a book-blind total produces: half a bitcoin added to half a
    // million lumens and printed as a quantity of neither. Every read that
    // totals anything has to pass an asset for exactly this reason.
    const blind = totalCollateral(await q.getPositionsForAddress(ADDR))
    expect(blind).toBe(501_007.5)
    expect(blind).not.toBe(totalCollateral(xlm))
    expect(blind).not.toBe(totalCollateral(btc))
  })

  it('scopes the activity mirror the same way', async () => {
    const deposits = await q.getRecentDeposits(25, ADDR, BTC)
    expect(queries[0].text).toMatch(/underlying = \$3/)
    expect(queries[0].params).toEqual([25, ADDR, 'BTC'])
    expect(deposits.map((d) => d.underlying)).toEqual(['BTC'])
  })

  it('still names the book on an unscoped mirror read', async () => {
    const deposits = await q.getRecentDeposits(25)
    expect(deposits.map((d) => d.underlying)).toEqual(['XLM', 'BTC', 'XLM', 'XLM'])
  })
})

describe('a position id does not identify a position', () => {
  const OTHER_VAULT = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K'

  it('keys the same number in two instances apart', () => {
    expect(settlementKey(XLM.contracts.vault, 3)).not.toBe(
      settlementKey(OTHER_VAULT, 3)
    )
  })

  it('does not hand one instance s settlement to another s position', () => {
    const settlements = new Map([
      [settlementKey(OTHER_VAULT, 3), { outcome: 'assigned' }],
    ])
    expect(settlements.get(settlementKey(XLM.contracts.vault, 3))).toBeUndefined()
    expect(settlements.get(settlementKey(OTHER_VAULT, 3))).toBeDefined()
  })
})

describe('settlement names the token it actually pays', () => {
  const assignedPut = {
    side: 'put' as const,
    collateral: 1_000,
    strike: 50_000,
    outcome: 'assigned' as const,
  }
  const keptCall = {
    side: 'call' as const,
    collateral: 2,
    strike: 50_000,
    outcome: 'kept' as const,
  }

  it('pays an assigned put in the book s own underlying', () => {
    expect(settlementPayout(assignedPut, BTC)?.asset).toBe('BTC')
    expect(settlementPayout(assignedPut, XLM)?.asset).toBe('XLM')
  })

  it('returns a kept call s escrow in the token it went in as', () => {
    expect(settlementPayout(keptCall, BTC)?.asset).toBe('BTC')
  })

  it('pays an assigned call in cash whichever book it is', () => {
    expect(settlementPayout({ ...keptCall, outcome: 'assigned' }, BTC)?.asset).toBe(
      'LUSD'
    )
  })

  it('defaults to XLM, which is what every Tranche 1 caller meant', () => {
    expect(settlementPayout(assignedPut)?.asset).toBe('XLM')
  })
})

describe('the browser cache filters by book too', () => {
  it('reads an uncached book as empty and an unlabelled row as XLM', async () => {
    const store = new Map<string, string>()
    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    })

    const cache = await import('../positions')
    cache.savePosition({
      id: 'a',
      address: ADDR,
      type: 'call',
      asset: 'XLM',
      collateralAmount: 100,
      strikePrice: 1,
      strikeIndex: 0,
      apr: 0.1,
      premium: 1,
      depositHash: 'a',
      premiumHash: 'a',
      expiryIso: '2026-09-25T00:00:00.000Z',
      expiryLabel: 'Sep_25',
      daysToExpirySnapshot: 7,
      createdAt: 1,
      settled: false,
    })

    expect(cache.getPositionsFor(ADDR, 'XLM')).toHaveLength(1)
    expect(cache.getPositionsFor(ADDR, 'BTC')).toHaveLength(0)
    expect(cache.getPositionsFor(ADDR)).toHaveLength(1)

    vi.unstubAllGlobals()
  })
})
