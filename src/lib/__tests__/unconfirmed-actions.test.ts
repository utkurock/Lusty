import { beforeEach, describe, expect, it, vi } from 'vitest'

// Reserved and never confirmed.
// =============================
// A row past the window is reported once, when it first crosses it, with the
// hash that decides whether the user was paid. The cursor is Postgres' own
// text for reserved_at, so a row is never reported twice by rounding.

const queries: { sql: string; params: any[] }[] = []
let rows: any[] = []
let cursor: string | null = null
let queryError: Error | null = null

vi.mock('@/lib/db', () => ({
  ensureSchema: async () => {},
  getPool: () => ({
    query: async (sql: string, params: any[] = []) => {
      queries.push({ sql, params })
      if (queryError) throw queryError
      if (sql.includes('select cursor')) return { rows: cursor ? [{ cursor }] : [] }
      if (sql.includes('from processed_actions')) {
        const after = params[1]
        return { rows: rows.map((r) => ({ ...r, is_new: after === null || r.reserved_at > after })) }
      }
      cursor = params[1]
      return { rows: [] }
    },
  }),
}))

const { checkUnconfirmedActions, unconfirmedActionsAlert } = await import('../monitor/unconfirmed-actions')

const FUNDING = 'a'.repeat(64)
const PAYOUT = 'b'.repeat(64)
const row = (reserved_at: string, over: Partial<{ action_type: string; source_hash: string; payout_hash: string | null }> = {}) => ({
  action_type: over.action_type ?? 'swap',
  source_hash: over.source_hash ?? FUNDING,
  payout_hash: over.payout_hash === undefined ? PAYOUT : over.payout_hash,
  reserved_at,
})

beforeEach(() => {
  queries.length = 0
  rows = []
  cursor = null
  queryError = null
})

describe('checkUnconfirmedActions', () => {
  it('is quiet when nothing is stuck', async () => {
    expect(await checkUnconfirmedActions()).toBeNull()
  })

  it('pages on a swap payout whose outcome is unknown, naming the payout hash', async () => {
    rows = [row('2026-11-25 10:00:00.123456+00')]
    const alert = await checkUnconfirmedActions()
    expect(alert?.severity).toBe('critical')
    expect(alert?.message).toContain(PAYOUT)
    expect(alert?.message).toContain('confirmed')
    expect(cursor).toBe('2026-11-25 10:00:00.123456+00')
  })

  it('reports a row once, and only rows that crossed the window since', async () => {
    rows = [row('2026-11-25 10:00:00.123456+00')]
    expect(await checkUnconfirmedActions()).not.toBeNull()
    expect(await checkUnconfirmedActions()).toBeNull()

    rows.push(row('2026-11-25 10:30:00+00', { action_type: 'deposit', source_hash: 'XLM:42', payout_hash: null }))
    const alert = await checkUnconfirmedActions()
    expect(alert?.severity).toBe('warning')
    expect(alert?.message).toContain('XLM:42')
    expect(alert?.message).not.toContain(PAYOUT)
    // The old one is still counted, so it is not forgotten.
    expect(alert?.fields?.find((f) => f.label === 'outstanding')?.value).toBe('2')
  })

  it('reads only unconfirmed rows past the window', async () => {
    await checkUnconfirmedActions()
    const read = queries.find((q) => q.sql.includes('from processed_actions'))!
    expect(read.sql).toContain('confirmed_at is null')
    expect(read.sql).toContain('make_interval(mins => $1)')
    expect(read.params[0]).toBe(10)
  })

  it('is critical when the ledger cannot be read, rather than quiet', async () => {
    queryError = new Error('connection refused')
    const alert = await checkUnconfirmedActions()
    expect(alert?.severity).toBe('critical')
    expect(alert?.message).toContain('connection refused')
  })
})

describe('unconfirmedActionsAlert', () => {
  it('says a swap with no payout hash was never paid', () => {
    const alert = unconfirmedActionsAlert(
      [{ actionType: 'swap', sourceHash: FUNDING, payoutHash: null, reservedAt: 't' }],
      1,
    )!
    expect(alert.severity).toBe('critical')
    expect(alert.message).toContain('no payout was ever recorded')
  })

  it('is null for nothing new', () => {
    expect(unconfirmedActionsAlert([], 3)).toBeNull()
  })
})
