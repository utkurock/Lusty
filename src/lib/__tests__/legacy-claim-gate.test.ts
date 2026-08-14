import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The retired payout path stays shut unless an operator opens it.
// ===============================================================
// /api/vault/claim is the last code in the system that can move collateral a
// user escrowed — it spends from the distributor account, which only this
// server holds a key to. Contract positions took that capability away; the
// legacy book is what is left of it. The flag is the catch, and the property
// that matters is which way it fails when nobody has set anything.

const ROUTE = 'src/app/api/vault/claim/route.ts'

function claimRoute(env: Record<string, string | undefined>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, '')
    else vi.stubEnv(k, v)
  }
  return import('@/app/api/vault/claim/route')
}

function post(body: unknown = {}) {
  return new Request('http://localhost/api/vault/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('the payout gate', () => {
  it('is closed when nothing is configured', async () => {
    const { POST } = await claimRoute({ LEGACY_CLAIM_ENABLED: undefined })
    const res = await POST(post({ address: 'GA', depositHash: 'x' }))

    expect(res.status).toBe(410)
    expect((await res.json()).code).toBe('legacy_claims_closed')
  })

  it('stays closed for values that are merely truthy', async () => {
    // A flag that opened on "false", "0" or "no" would be worse than no flag,
    // because it would look set correctly in a dashboard.
    for (const value of ['0', 'false', 'no', 'true', 'yes', 'enabled', ' 1']) {
      const { POST } = await claimRoute({ LEGACY_CLAIM_ENABLED: value })
      const res = await POST(post({ address: 'GA', depositHash: 'x' }))
      expect(res.status, `LEGACY_CLAIM_ENABLED=${JSON.stringify(value)}`).toBe(410)
    }
  })

  it('refuses before it reads anything about the request', async () => {
    // A malformed body would normally be a 400. Getting a 410 instead proves
    // the gate runs ahead of parsing, so no request shape reaches the payout.
    const { POST } = await claimRoute({ LEGACY_CLAIM_ENABLED: undefined })
    const res = await POST(
      new Request('http://localhost/api/vault/claim', {
        method: 'POST',
        body: 'not json at all',
      })
    )
    expect(res.status).toBe(410)
  })

  it('opens only on exactly "1"', async () => {
    const { POST } = await claimRoute({ LEGACY_CLAIM_ENABLED: '1' })
    const res = await POST(post({ address: 'not-a-key', depositHash: 'x' }))
    // Past the gate now: it gets far enough to reject the address itself,
    // which is the proof that the flag is what was stopping it.
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('invalid address')
  })
})

describe('the outstanding book', () => {
  function get(query = '', headers: Record<string, string> = {}) {
    return new Request(`http://localhost/api/vault/claim${query}`, { headers })
  }

  it('refuses the whole-rail total to a caller with no admin session', async () => {
    // Unscoped, this answers "how much does the operator still owe, to how
    // many wallets" — a fact about us, not about whoever asked. It used to
    // answer that to anyone who removed the query parameter.
    const { GET } = await claimRoute({})
    const res = await GET(get())
    expect(res.status).toBe(403)
    expect((await res.json()).error).toContain('not authorized')
  })

  it('rejects a bad address before it reaches the database', async () => {
    const { GET } = await claimRoute({})
    const res = await GET(get('?address=not-a-key'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('invalid address')
  })

  it('does not treat a stale session token as an admin', async () => {
    const { GET } = await claimRoute({})
    const res = await GET(get('', { 'x-admin-token': 'made-up' }))
    expect(res.status).toBe(401)
  })
})

describe('the gate sits in front of the spending key', () => {
  const source = readFileSync(resolve(process.cwd(), ROUTE), 'utf8')

  it('loads the distributor key only after the flag is checked', () => {
    const gate = source.indexOf('if (!LEGACY_CLAIM_ENABLED)')
    const key = source.indexOf('Keypair.fromSecret(DISTRIBUTOR_SECRET)')
    expect(gate).toBeGreaterThan(-1)
    expect(key).toBeGreaterThan(gate)
  })

  it('reads the flag as an exact match, not a presence check', () => {
    // `process.env.X ? ... :` or `!== undefined` would open on any value.
    expect(source).toContain("process.env.LEGACY_CLAIM_ENABLED === '1'")
  })

  it('keeps the read-only report free of the spending key', () => {
    const get = source.indexOf('export async function GET')
    const post = source.indexOf('export async function POST')
    expect(get).toBeGreaterThan(-1)
    expect(post).toBeGreaterThan(get)
    const getBody = source.slice(get, post)
    expect(getBody).not.toContain('DISTRIBUTOR_SECRET')
    expect(getBody).not.toContain('Keypair')
  })
})
