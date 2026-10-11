import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { Keypair, StrKey } from '@stellar/stellar-sdk'

// A wallet's positions, read by anyone, and what that read may write down.
//
// The APR reconstructed for an old row is noted on that row so it stops
// depending on a feed. What it must not note is the close it was derived from
// as `spotAtOpen`: that close is the indexing day's, and `spotAtOpen` is what
// the leaderboard values a call at. Nor may the note land on any other row that
// happens to share the hash — a bridge funding, say.

const XLM_VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x11))
const OWNER = Keypair.random().publicKey()
const DAY = 86_400_000

const queries: { sql: string; params: any[] }[] = []
vi.mock('@/lib/db', () => ({
  ensureSchema: async () => {},
  COLLATERAL_USD_SQL: 'null',
  getPool: () => ({
    query: async (sql: string, params: any[] = []) => {
      queries.push({ sql, params })
      return { rows: [], rowCount: 1 }
    },
  }),
}))

describe('backfillPositionApr', () => {
  beforeEach(() => {
    queries.length = 0
  })

  it('writes the APR alone, onto the position s own row', async () => {
    const { backfillPositionApr } = await import('../db-queries')
    await backfillPositionApr({ address: OWNER, underlying: 'XLM', positionId: 7 }, 12.5)

    expect(queries).toHaveLength(1)
    const { sql, params } = queries[0]
    expect(sql).toMatch(/where address = \$1/)
    expect(sql).toMatch(/and underlying = \$2/)
    expect(sql).toMatch(/and type = 'deposit'/)
    expect(sql).toMatch(/metadata->>'positionId' = \$3/)
    expect(sql).not.toMatch(/tx_hash/)
    expect(params.slice(0, 3)).toEqual([OWNER, 'XLM', '7'])
    const patch = JSON.parse(params[3])
    expect(patch).toEqual({ apr: 12.5, aprDerived: true })
    expect(patch).not.toHaveProperty('spotAtOpen')
  })

  it('writes nothing without a position to bind to', async () => {
    const { backfillPositionApr } = await import('../db-queries')
    await backfillPositionApr({ address: OWNER, underlying: 'XLM', positionId: NaN }, 12.5)
    await backfillPositionApr({ address: '', underlying: 'XLM', positionId: 7 }, 12.5)
    expect(queries).toHaveLength(0)
  })
})

describe('GET /api/vault/positions', () => {
  const backfill = vi.fn(async (..._a: any[]) => {})
  const opened = Date.now() - 2 * DAY

  let route: typeof import('@/app/api/vault/positions/route')

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_VAULT_CONTRACT = XLM_VAULT
    vi.doMock('@/lib/vault-contract', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../vault-contract')>()),
      getPositionsOf: async () => [
        {
          id: 7, owner: OWNER, side: 'call', collateral: 10_000, strike: 0.3,
          expiry: new Date(opened + 10 * DAY), premium: 25, settled: false, outcome: 'open',
        },
      ],
    }))
    vi.doMock('@/lib/db-queries', () => ({
      backfillPositionApr: (...a: any[]) => backfill(...a),
      // An old row: indexed before an APR or an open price was recorded.
      getPositionsForAddress: async () => [
        {
          id: 'f'.repeat(64), address: OWNER, type: 'call', asset: 'XLM', underlying: 'XLM',
          collateralAmount: 10_000, strikePrice: 0.3, apr: null, spotAtOpen: null, aprDerived: false,
          premium: 25, depositHash: 'f'.repeat(64), premiumHash: null, expiryIso: null, expiryLabel: '',
          daysToExpirySnapshot: null, createdAt: opened, settled: false, payoutHash: null,
          positionId: 7, fundedWith: null,
        },
      ],
    }))
    vi.doMock('@/lib/contract-events', () => ({
      fetchSettlements: async () => new Map(),
      settlementKey: (c: string, id: number) => `${c}#${id}`,
    }))
    vi.doMock('@/lib/price-history', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../price-history')>()),
      getDailyCloses: async () => [{ day: Math.floor(opened / DAY) * DAY, close: 0.25 }],
    }))
    route = await import('@/app/api/vault/positions/route')
  })

  const get = (ip: string, address = OWNER) =>
    route.GET(
      new Request(`http://t/api/vault/positions?address=${address}`, {
        headers: { 'cf-connecting-ip': ip },
      }),
    )

  it('backfills the derived APR against the position, not the hash', async () => {
    const res = await get('192.0.2.1')
    const out = await res.json()
    expect(res.status).toBe(200)
    expect(out.positions[0].aprSource).toBe('derived')

    await vi.waitFor(() => expect(backfill).toHaveBeenCalled())
    const [row, apr] = backfill.mock.calls[0]
    expect(row).toEqual({ address: OWNER, underlying: 'XLM', positionId: 7 })
    expect(apr).toBe(out.positions[0].apr)
    // No third argument: the day's close is shown, never stored as the open.
    expect(backfill.mock.calls[0]).toHaveLength(2)
  })

  it('limits per client, so minting addresses does not mint budget', async () => {
    const client = '192.0.2.2'
    let last = 0
    for (let i = 0; i < 61; i++) last = (await get(client, Keypair.random().publicKey())).status
    expect(last).toBe(429)
    // Another client is unaffected.
    expect((await get('192.0.2.3')).status).toBe(200)
  })
})
