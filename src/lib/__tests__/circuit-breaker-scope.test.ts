import { describe, it, expect, beforeEach, vi } from 'vitest'

// One breaker for every book let a thin market, moved on purpose, halt the
// whole desk. Each book now has its own switch, and the desk keeps one over
// all of them. These pin which switch a book obeys and which one each auto
// condition trips.

type Row = {
  scope: string
  tripped: boolean
  reason: string | null
  source: string
  updated_by: string | null
  updated_at: Date
}
const table = new Map<string, Row>()

vi.mock('@/lib/db', () => ({
  ensureSchema: async () => {},
  getPool: () => ({
    query: async (sql: string, params: any[]) => {
      if (/^\s*insert into circuit_breakers/.test(sql)) {
        const [scope, tripped, reason, source, updated_by] = params
        table.set(scope, { scope, tripped, reason, source, updated_by, updated_at: new Date() })
        return { rows: [] }
      }
      if (/where scope = any/.test(sql)) {
        return { rows: (params[0] as string[]).flatMap((s) => (table.has(s) ? [table.get(s)] : [])) }
      }
      if (/where scope = \$1/.test(sql)) {
        return { rows: table.has(params[0]) ? [table.get(params[0])] : [] }
      }
      return { rows: [...table.values()] }
    },
  }),
}))

// XLM's feed moves 12% in a minute; BTC's is calm. No assignments this epoch.
const closes: Record<string, number[]> = {
  XLM: [0.2, 0.2, 0.2, 0.2, 0.2, 0.224],
  BTC: [60_000, 60_010, 60_005, 60_020, 60_000, 60_015],
}
vi.mock('@/lib/monitor/checks', () => ({
  computeVolRatio: async () => 1,
  fetchCloses: async (_i: string, _n: number, asset: { symbol: string }) => closes[asset.symbol],
}))

// Both books live, whatever this environment configures.
vi.mock('@/lib/assets', async (importOriginal) => {
  const real = await importOriginal<typeof import('../assets')>()
  return { ...real, enabledUnderlyings: () => [real.XLM, real.BTC] }
})

const { getBreakerState, setBreaker, ALL_BOOKS } = await import('../circuit-breaker')
const { applyAutoBreaker } = await import('../monitor/triggers')

beforeEach(() => {
  table.clear()
})

describe('getBreakerState', () => {
  it('reads open when nothing was ever set', async () => {
    expect((await getBreakerState('XLM')).tripped).toBe(false)
    expect((await getBreakerState()).scope).toBe(ALL_BOOKS)
  })

  it('halts only the book whose switch is tripped', async () => {
    await setBreaker({ scope: 'xlm', tripped: true, reason: 'thin market' })
    expect(await getBreakerState('XLM')).toMatchObject({ scope: 'XLM', tripped: true, reason: 'thin market' })
    expect((await getBreakerState('BTC')).tripped).toBe(false)
  })

  it('halts every book when the desk switch is tripped', async () => {
    await setBreaker({ tripped: true, reason: 'admin halt' })
    for (const book of ['XLM', 'BTC']) {
      expect(await getBreakerState(book)).toMatchObject({ scope: ALL_BOOKS, tripped: true })
    }
  })
})

describe('applyAutoBreaker', () => {
  it('trips the book whose market moved and leaves the others quoting', async () => {
    const changes = await applyAutoBreaker()
    expect(changes.map((c) => c.state.scope)).toEqual(['XLM'])
    expect((await getBreakerState('XLM')).tripped).toBe(true)
    expect((await getBreakerState('BTC')).tripped).toBe(false)
    expect((await getBreakerState()).tripped).toBe(false)
  })

  it('clears its own trip once the market calms, and never a manual one', async () => {
    await applyAutoBreaker()
    await setBreaker({ scope: 'BTC', tripped: true, source: 'manual', reason: 'by hand' })
    closes.XLM = [0.2, 0.2, 0.2, 0.2, 0.2, 0.2]
    const changes = await applyAutoBreaker()
    expect(changes.map((c) => [c.state.scope, c.state.tripped])).toEqual([['XLM', false]])
    expect((await getBreakerState('BTC')).tripped).toBe(true)
  })
})
