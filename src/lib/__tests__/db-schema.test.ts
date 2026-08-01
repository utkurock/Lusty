import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Schema initialisation runs once per process, not once per caller.
// =================================================================
// Reproduced against the real database before this was written: eight
// concurrent callers ran the DDL eight times and seven of them failed with
// `relation "leaderboard_view" already exists`, because the view has to be
// dropped and recreated and Postgres has no `create view if not exists`. Every
// request waiting on one of those runs failed with it — 500s on the
// database-backed routes, and false 403s from the admin check, which denies
// when its lookup throws. Afterwards: one run, no failures.
//
// The pool is mocked so this holds in CI, where there is no database.

const query = vi.fn<(sql: string) => Promise<unknown>>()

vi.mock('pg', () => ({
  Pool: class {
    query = query
    on = vi.fn()
  },
}))

function resetProcessState() {
  const g = globalThis as any
  g.__pgPool = undefined
  g.__pgSchemaReady = undefined
  g.__pgSchemaInFlight = undefined
}

beforeEach(() => {
  vi.resetModules()
  resetProcessState()
  query.mockReset()
  query.mockResolvedValue({ rows: [] })
  vi.stubEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/test')
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetProcessState()
})

describe('ensureSchema', () => {
  it('runs the DDL once for many concurrent callers', async () => {
    const { ensureSchema } = await import('../db')

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => ensureSchema())
    )
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
    const concurrent = query.mock.calls.length

    // What one run costs, measured the same way in a fresh process.
    vi.resetModules()
    resetProcessState()
    query.mockClear()
    const fresh = await import('../db')
    await fresh.ensureSchema()

    expect(concurrent).toBe(query.mock.calls.length)
  })

  it('does no work at all once the schema is ready', async () => {
    const { ensureSchema } = await import('../db')
    await ensureSchema()
    const afterFirst = query.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)

    await Promise.all([ensureSchema(), ensureSchema(), ensureSchema()])
    expect(query.mock.calls.length).toBe(afterFirst)
  })

  it('rejects every caller sharing a failed run', async () => {
    query.mockRejectedValue(new Error('connection refused'))
    const { ensureSchema } = await import('../db')

    const results = await Promise.allSettled([ensureSchema(), ensureSchema()])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
  })

  it('retries after a failure instead of caching it forever', async () => {
    // A cached rejection would leave the process permanently unable to reach
    // its own database over one transient connection error.
    query.mockRejectedValueOnce(new Error('connection refused'))
    const { ensureSchema } = await import('../db')

    await expect(ensureSchema()).rejects.toThrow('connection refused')

    query.mockResolvedValue({ rows: [] })
    await expect(ensureSchema()).resolves.toBeUndefined()
    await expect(ensureSchema()).resolves.toBeUndefined()
  })

  it('tolerates another instance creating the view in the same moment', async () => {
    // Serialising within a process cannot stop two of them booting together.
    // Losing that race is harmless: the definition is ours either way.
    const duplicate: any = new Error('relation "leaderboard_view" already exists')
    duplicate.code = '42P07'
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('create view leaderboard_view')) throw duplicate
      return { rows: [] }
    })

    const { ensureSchema } = await import('../db')
    await expect(ensureSchema()).resolves.toBeUndefined()
  })

  it('still surfaces a real failure on the view', async () => {
    const broken: any = new Error('syntax error at or near "slect"')
    broken.code = '42601'
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('create view leaderboard_view')) throw broken
      return { rows: [] }
    })

    const { ensureSchema } = await import('../db')
    await expect(ensureSchema()).rejects.toThrow('syntax error')
  })
})
