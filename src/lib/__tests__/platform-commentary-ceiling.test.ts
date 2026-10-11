import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The desk note's shared ceiling exists to bound Binance and Gemini calls. It
// was charged on every read, cached ones included, so ordinary panel traffic
// spent it and readers were answered 429 for a note already in the database.

const row = vi.hoisted(() => ({ value: null as any }))
const durable = vi.hoisted(() => vi.fn(async () => ({ ok: true }) as any))

vi.mock('@/lib/db', () => ({
  ensureSchema: async () => {},
  getPool: () => ({
    query: async () => ({ rows: row.value ? [row.value] : [] }),
  }),
}))
vi.mock('@/lib/rate-limit', () => ({
  clientRateLimit: () => ({ ok: true }),
  durableRateLimit: durable,
}))
vi.mock('@/lib/admin-auth', () => ({ isAdminRequest: async () => false }))

const fetchSpy = vi.fn(async () => {
  throw new Error('no network in tests')
})

function note(ageMs: number) {
  return {
    generated_at: new Date(Date.now() - ageMs).toISOString(),
    price: '0.12',
    change_24h: '1.5',
    bias: 'neutral',
    headline: 'cached headline',
    bullets: ['a'],
    suggestion: 's',
    source: 'gemini',
  }
}

async function get() {
  const { GET } = await import('@/app/api/research/commentary/route')
  const res = await GET(new Request('http://localhost/api/research/commentary'))
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  row.value = null
  durable.mockReset()
  durable.mockResolvedValue({ ok: true })
  fetchSpy.mockClear()
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the commentary ceiling is charged only for a regeneration', () => {
  it('serves a fresh cached note without touching the shared ceiling', async () => {
    row.value = note(60_000)
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(body).toMatchObject({ cached: true, headline: 'cached headline' })
    expect(durable).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('charges the ceiling when the note has aged out', async () => {
    row.value = note(2 * 3_600_000)
    await get()
    expect(durable).toHaveBeenCalledWith('commentary:global', 60_000, 30)
  })

  it('serves the stale note, not a 429, when the ceiling is spent', async () => {
    row.value = note(2 * 3_600_000)
    durable.mockResolvedValue({ ok: false, retryAfter: 30 })
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(body).toMatchObject({ cached: true, stale: true, headline: 'cached headline' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('serves the static fallback when the ceiling is spent and nothing is cached', async () => {
    durable.mockResolvedValue({ ok: false, retryAfter: 30 })
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(body).toMatchObject({ source: 'static', stale: true })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
