import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ORACLE_HISTORY_SECS } from '../oracle-window'

// The runner heartbeat.
// =====================
// Two halves, tested apart. The rule is pure: given the run log's last row,
// is the runner keeping up? The recording is a pair of writes, and both have
// to be survivable — a sweep that cannot write its row must still sweep, or
// the watch would cause exactly what it exists to catch.

const INTERVAL_MS = 15 * 60_000
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0)

const queries: { sql: string; params: any[] }[] = []
let queryResult: any = { rows: [{ id: 7 }] }
let queryError: Error | null = null

vi.mock('@/lib/db', () => ({
  ensureSchema: async () => {},
  getPool: () => ({
    query: async (sql: string, params: any[] = []) => {
      queries.push({ sql, params })
      if (queryError) throw queryError
      return queryResult
    },
  }),
}))

const { recordRunEnd, recordRunStart, runnerHealthAlert, checkRunnerHealth } = await import(
  '../monitor/runner-watch'
)

type State = Parameters<typeof runnerHealthAlert>[0]

const healthy = (): State => ({
  lastFinishedAt: new Date(NOW - 60_000),
  lastOutcome: 'ok',
  lastError: null,
  openSince: null,
  total: 42,
})

const alertOf = (mutate: (s: State) => void = () => {}) => {
  const s = healthy()
  mutate(s)
  return runnerHealthAlert(s, NOW, INTERVAL_MS)
}

beforeEach(() => {
  queries.length = 0
  queryResult = { rows: [{ id: 7 }] }
  queryError = null
})

describe('runnerHealthAlert', () => {
  it('says nothing about a runner that finished inside its interval', () => {
    expect(alertOf()).toBeNull()
    // One interval late is slowness, not an outage.
    expect(alertOf((s) => {
      s.lastFinishedAt = new Date(NOW - INTERVAL_MS - 1)
    })).toBeNull()
  })

  it('pages when no run has ever been recorded', () => {
    const a = alertOf((s) => {
      s.total = 0
      s.lastFinishedAt = null
      s.lastOutcome = null
    })
    expect(a?.severity).toBe('critical')
    expect(a?.title).toBe('Settlement runner has never run')
  })

  it('warns after two missed intervals and pages once a quarter of the oracle window is gone', () => {
    const late = alertOf((s) => {
      s.lastFinishedAt = new Date(NOW - INTERVAL_MS * 2 - 1)
    })
    expect(late?.severity).toBe('warning')
    expect(late?.title).toBe('Settlement runner is late')

    const stopped = alertOf((s) => {
      s.lastFinishedAt = new Date(NOW - (ORACLE_HISTORY_SECS * 1000) / 4 - 1)
    })
    expect(stopped?.severity).toBe('critical')
    expect(stopped?.title).toBe('Settlement runner has stopped')
    expect(stopped?.message).toContain('permissionless')
  })

  // A row opened and never closed is the shape a process that died mid-sweep
  // leaves behind, and no later run completed, so it outranks lateness.
  it('pages on a run that started and never finished', () => {
    const a = alertOf((s) => {
      s.openSince = new Date(NOW - INTERVAL_MS * 2 - 1)
      s.lastFinishedAt = new Date(NOW - INTERVAL_MS * 10)
    })
    expect(a?.severity).toBe('critical')
    expect(a?.title).toBe('Settlement run started and never finished')
    expect(a?.fields?.find((f) => f.label === 'open_since')).toBeDefined()
  })

  it('does not call a run that is merely in flight a wedged one', () => {
    expect(alertOf((s) => {
      s.openSince = new Date(NOW - 30_000)
    })).toBeNull()
  })

  it('reports the last run having failed, once it is no longer late', () => {
    const a = alertOf((s) => {
      s.lastOutcome = 'error'
      s.lastError = 'RPC 503'
    })
    expect(a?.severity).toBe('warning')
    expect(a?.title).toBe('Last settlement run failed')
    expect(a?.message).toContain('RPC 503')
  })

  it('names the interval it is judging against, so a slowed sweep is readable', () => {
    const a = runnerHealthAlert({ ...healthy(), total: 0 }, NOW, 60 * 60_000)
    expect(a?.fields).toEqual(
      expect.arrayContaining([{ label: 'interval_min', value: '60.0' }]),
    )
  })
})

describe('recording a run', () => {
  it('opens a row with its source and returns the id', async () => {
    expect(await recordRunStart('scheduler')).toBe(7)
    expect(queries[0].sql).toContain('insert into settlement_runs')
    expect(queries[0].params).toEqual(['scheduler'])
  })

  it('closes the row it opened, with the outcome and the detail as json', async () => {
    await recordRunEnd(7, { outcome: 'ok', settled: 2, failed: 1, due: 3, detail: { failed: [] } })
    expect(queries[0].sql).toContain('update settlement_runs')
    expect(queries[0].params.slice(0, 5)).toEqual([7, 'ok', 2, 1, 3])
    expect(JSON.parse(queries[0].params[5])).toEqual({ failed: [] })
  })

  // The sweep must outlive its own bookkeeping: the cost of a missing row is
  // a late alert, the cost of not settling is collateral nobody can release.
  it('never throws when the run log cannot be written', async () => {
    queryError = new Error('DATABASE_URL not set')
    expect(await recordRunStart('endpoint')).toBeNull()
    await expect(recordRunEnd(7, { outcome: 'ok', settled: 0, failed: 0, due: 0 })).resolves.toBeUndefined()
  })

  it('does nothing when there is no row to close', async () => {
    await recordRunEnd(null, { outcome: 'ok', settled: 0, failed: 0, due: 0 })
    expect(queries).toEqual([])
  })
})

describe('checkRunnerHealth', () => {
  it('reads the log and judges it', async () => {
    queryResult = {
      rows: [
        {
          total: '3',
          last_finished: new Date(Date.now() - 60_000).toISOString(),
          open_since: null,
          last_outcome: 'ok',
          last_detail: null,
        },
      ],
    }
    expect(await checkRunnerHealth()).toBeNull()
  })

  it("reads the reason out of the last row's detail", async () => {
    queryResult = {
      rows: [
        {
          total: '3',
          last_finished: new Date(Date.now() - 60_000).toISOString(),
          open_since: null,
          last_outcome: 'error',
          last_detail: JSON.stringify({ error: 'horizon timed out' }),
        },
      ],
    }
    expect((await checkRunnerHealth())?.message).toContain('horizon timed out')
  })

  // A blind watch is itself worth paging about: it cannot tell a healthy
  // runner from a stopped one.
  it('pages when the run log cannot be read', async () => {
    queryError = new Error('connection refused')
    const a = await checkRunnerHealth()
    expect(a?.severity).toBe('critical')
    expect(a?.title).toBe('Settlement runner watch failed')
  })
})
