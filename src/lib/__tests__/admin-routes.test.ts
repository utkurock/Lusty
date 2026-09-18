import { describe, it, expect, vi, beforeEach } from 'vitest'

// The diagnostic endpoint used to be open. What it returns is not dangerous to
// the person who owns the deployment and is a free reconnaissance report for
// anybody else: row counts for users, positions and admins, the table names,
// the driver's own error strings (which name the host and the role on a failed
// connection), and whether the database connection verifies TLS. It also runs
// `ensureSchema`, so an anonymous caller could drive DDL and a round trip per
// request.

const queries: string[] = []

vi.mock('@/lib/db', () => ({
  ensureSchema: async () => {
    queries.push('ensureSchema')
  },
  getPool: () => ({
    query: async (text: string) => {
      queries.push(text)
      return { rows: [{ ok: 1, c: 0 }] }
    },
  }),
}))

const validate = vi.hoisted(() => vi.fn<(token: string) => string | null>())
vi.mock('@/lib/admin-sessions', () => ({ validateSession: validate }))

beforeEach(() => {
  queries.length = 0
  validate.mockReset()
})

async function get(headers: Record<string, string> = {}) {
  const { GET } = await import('@/app/api/debug/db/route')
  return GET(new Request('http://localhost/api/debug/db', { headers }))
}

describe('/api/debug/db is admin only', () => {
  it('refuses a request with no session token', async () => {
    const res = await get()
    expect(res.status).toBe(403)
    // And refuses it before touching the database, so an anonymous caller
    // cannot drive DDL or a round trip either.
    expect(queries).toEqual([])
  })

  it('refuses a token no session knows', async () => {
    validate.mockReturnValue(null)
    const res = await get({ 'x-admin-token': 'not-a-session' })
    expect(res.status).toBe(401)
    expect(queries).toEqual([])
  })

  it('answers an admin session', async () => {
    validate.mockReturnValue('GADMIN')
    const res = await get({ 'x-admin-token': 'a-real-session' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.steps)).toBe(true)
    expect(queries.length).toBeGreaterThan(0)
  })
})
