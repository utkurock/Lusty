import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The durable limiter's whole claim is that a limit outlives the process that
// counted it. So the test restarts the process — a fresh module graph, an
// empty in-memory map — and asserts the count is still there, the way a
// deploy or a second replica would meet it.
//
// The pool is mocked with a tiny table so this runs without a database. Only
// the two statements the limiter issues are understood; the schema DDL and
// the sweep fall through to an empty result.

type Row = { key: string; bucket: number; hits: number }
let table: Row[] = []
let failing = false

const query = vi.fn(async (sql: string, params: any[] = []) => {
  if (failing) throw new Error('connection refused')
  if (/^\s*select bucket, hits from rate_limits/.test(sql)) {
    const [key, b1, b2] = params
    return { rows: table.filter((r) => r.key === key && (r.bucket === b1 || r.bucket === b2)) }
  }
  if (/^\s*insert into rate_limits/.test(sql)) {
    const [key, bucket] = params
    const row = table.find((r) => r.key === key && r.bucket === bucket)
    if (row) row.hits += 1
    else table.push({ key, bucket, hits: 1 })
    return { rows: [] }
  }
  return { rows: [] }
})

vi.mock('pg', () => ({
  Pool: class {
    query = query
    on = vi.fn()
  },
}))

function resetProcess() {
  vi.resetModules()
  const g = globalThis as any
  g.__pgPool = undefined
  g.__pgSchemaReady = undefined
  g.__pgSchemaInFlight = undefined
}

beforeEach(() => {
  table = []
  failing = false
  query.mockClear()
  resetProcess()
  vi.stubEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/test')
  vi.useFakeTimers({ toFake: ['Date'] })
  // Start of a window, so the previous bucket carries no weight to reason about.
  vi.setSystemTime(new Date(3600_000 * 1000))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetProcess()
})

describe('durableRateLimit', () => {
  it('keeps the count across a restart', async () => {
    const first = await import('../rate-limit')
    for (let i = 0; i < 3; i++) {
      expect((await first.durableRateLimit('faucet:LBTC:G1', 3600_000, 3)).ok).toBe(true)
    }

    resetProcess()
    const second = await import('../rate-limit')
    // The in-memory limiter alone would say yes here: its map is empty.
    expect(second.rateLimit('faucet:LBTC:G1', 3600_000, 3).ok).toBe(true)
    const after = await second.durableRateLimit('faucet:LBTC:G1', 3600_000, 3)
    expect(after.ok).toBe(false)
    if (!after.ok) expect(after.retryAfter).toBeGreaterThan(0)
  })

  it('does not count a refused request', async () => {
    const { durableRateLimit } = await import('../rate-limit')
    for (let i = 0; i < 2; i++) await durableRateLimit('k', 60_000, 2)
    resetProcess()
    const again = await import('../rate-limit')
    for (let i = 0; i < 5; i++) await again.durableRateLimit('k', 60_000, 2)
    expect(table.find((r) => r.key === 'k@60000')?.hits).toBe(2)
  })

  it('keeps separate counts for one key under two windows', async () => {
    const { durableRateLimit } = await import('../rate-limit')
    expect((await durableRateLimit('feedback', 60_000, 1)).ok).toBe(true)
    expect((await durableRateLimit('feedback', 86_400_000, 1)).ok).toBe(true)
  })

  it('falls back to the per-process limit when the database is down', async () => {
    failing = true
    const { durableRateLimit } = await import('../rate-limit')
    expect((await durableRateLimit('k', 60_000, 1)).ok).toBe(true)
    expect((await durableRateLimit('k', 60_000, 1)).ok).toBe(false)
  })

  it('uses the per-process limit alone when no database is configured', async () => {
    vi.stubEnv('DATABASE_URL', '')
    const { durableRateLimit } = await import('../rate-limit')
    expect((await durableRateLimit('k', 60_000, 1)).ok).toBe(true)
    expect((await durableRateLimit('k', 60_000, 1)).ok).toBe(false)
    expect(query).not.toHaveBeenCalled()
  })
})

describe('slidingWindowDecision', () => {
  it('admits while the weighted count is under the limit', async () => {
    const { slidingWindowDecision } = await import('../rate-limit')
    // Halfway through: 4 from last window weigh 2, plus 2 now, plus this one = 5.
    expect(slidingWindowDecision(4, 2, 30_000, 60_000, 5).ok).toBe(true)
    expect(slidingWindowDecision(4, 3, 30_000, 60_000, 5).ok).toBe(false)
  })

  it('waits for the previous window to fade when that is enough', async () => {
    const { slidingWindowDecision } = await import('../rate-limit')
    // 10 last window, 0 now, limit 5, at the start: fits once 10·(1−f) ≤ 4, f = 0.6.
    const d = slidingWindowDecision(10, 0, 0, 60_000, 5)
    expect(d).toEqual({ ok: false, retryAfter: 36 })
  })

  it('waits into the next window when this one is already full', async () => {
    const { slidingWindowDecision } = await import('../rate-limit')
    // 5 now, limit 5, at f = 0.5: the 5 become last window's, and fit once 5·(1−f) ≤ 4.
    const d = slidingWindowDecision(0, 5, 30_000, 60_000, 5)
    expect(d).toEqual({ ok: false, retryAfter: 42 })
  })
})
