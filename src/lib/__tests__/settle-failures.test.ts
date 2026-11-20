import { beforeEach, describe, expect, it, vi } from 'vitest'

// Settle failures, reported when they happen.
// ===========================================
// The rule is pure: given the last two runs' recorded failures, what is new,
// and what does it say. The reader's job is only to not report the same run
// twice — the monitor ticks more often than the sweep runs.

const queries: { sql: string; params: any[] }[] = []
let runs: any[] = []
let cursor: string | null = null
let queryError: Error | null = null

vi.mock('@/lib/db', () => ({
  ensureSchema: async () => {},
  getPool: () => ({
    query: async (sql: string, params: any[] = []) => {
      queries.push({ sql, params })
      if (queryError) throw queryError
      if (sql.includes('from settlement_runs')) return { rows: runs }
      if (sql.includes('select cursor')) return { rows: cursor ? [{ cursor }] : [] }
      cursor = params[1]
      return { rows: [] }
    },
  }),
}))

const { checkSettleFailures, newFailures, settleFailureAlert } = await import(
  '../monitor/settle-failures'
)
const { XLM } = await import('../assets')

const VAULT = XLM.contracts.vault
const fail = (id: number, over: Partial<{ error: string; permanent: boolean; vault: string }> = {}) => ({
  id,
  underlying: 'XLM' as const,
  vault: over.vault ?? VAULT,
  error: over.error ?? 'HostError: Error(Contract, #10)',
  permanent: over.permanent ?? false,
})

const run = (id: number, failed: any[]) => ({
  id,
  finished_at: '2026-11-20T12:00:00.000Z',
  detail: JSON.stringify({ failed }),
})

beforeEach(() => {
  queries.length = 0
  runs = []
  cursor = null
  queryError = null
})

describe('newFailures', () => {
  it('is everything in the latest run when the one before it had none', () => {
    expect(newFailures([fail(3), fail(4)], [])).toHaveLength(2)
  })

  // A position failing identically every run was reported once already; from
  // there it belongs to the backlog check, which carries its deadline.
  it('leaves out a position that was already failing last run', () => {
    expect(newFailures([fail(3), fail(4)], [fail(3)])).toEqual([fail(4)])
  })

  it("tells two instances' positions apart, since ids restart at 0 in each", () => {
    const retired = 'CRETIREDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
    expect(newFailures([fail(3, { vault: retired })], [fail(3)])).toHaveLength(1)
  })
})

describe('settleFailureAlert', () => {
  it('says nothing when nothing failed', () => {
    expect(settleFailureAlert([], '2026-11-20T12:00:00.000Z')).toBeNull()
  })

  it('warns on a retryable failure, naming the position, the book and the contract error', () => {
    const a = settleFailureAlert([fail(3)], '2026-11-20T12:00:00.000Z')
    expect(a?.severity).toBe('warning')
    expect(a?.title).toBe('Settle transaction failed')
    expect(a?.message).toContain('XLM#3')
    expect(a?.message).toContain('Error(Contract, #10)')
    expect(a?.message).toContain('will try again')
    expect(a?.fields).toEqual(
      expect.arrayContaining([{ label: 'failed', value: '1' }, { label: 'permanent', value: '0' }]),
    )
  })

  it('pages when a failure is permanent, and says what the collateral depends on', () => {
    const a = settleFailureAlert([fail(5, { permanent: true, error: 'trustline missing' })], null)
    expect(a?.severity).toBe('critical')
    expect(a?.title).toBe('Settlement refused and no retry will help')
    expect(a?.message).toContain('thirty-day')
    expect(a?.message).toContain('an unrecorded time')
  })

  it('names a retired instance apart from the current book', () => {
    const retired = 'CRETIREDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
    const a = settleFailureAlert([fail(29, { vault: retired })], '2026-11-20T12:00:00.000Z')
    expect(a?.message).toContain('XLM@CRET…XXXX#29')
  })
})

describe('checkSettleFailures', () => {
  it('says nothing when no run has completed', async () => {
    expect(await checkSettleFailures()).toBeNull()
  })

  it("reports the latest run's new failures and advances past that run", async () => {
    runs = [run(12, [fail(3), fail(4)]), run(11, [fail(3)])]
    const a = await checkSettleFailures()
    expect(a?.message).toContain('XLM#4')
    expect(a?.message).not.toContain('XLM#3')
    expect(cursor).toBe('12')
  })

  // The monitor runs every few minutes and the sweep every quarter hour, so
  // most ticks are looking at a run they have already read.
  it('does not report the same run twice', async () => {
    runs = [run(12, [fail(4)]), run(11, [])]
    cursor = '12'
    expect(await checkSettleFailures()).toBeNull()
  })

  it('ignores a run that itself errored, since its failure list says nothing', async () => {
    runs = []
    await checkSettleFailures()
    expect(queries[0].sql).toContain("outcome <> 'error'")
  })

  it('pages when the run log cannot be read, rather than reporting nothing failed', async () => {
    queryError = new Error('connection refused')
    const a = await checkSettleFailures()
    expect(a?.severity).toBe('critical')
    expect(a?.title).toBe('Settlement failure watch failed')
  })
})
