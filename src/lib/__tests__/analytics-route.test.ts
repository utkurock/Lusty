import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanMetadata } from '../analytics-metadata'

// A public, unauthenticated write into Postgres. Each row has to stay the size
// of an event, and the caller must not be the one choosing the limiter's key.

const logged = vi.hoisted(() => [] as any[])
vi.mock('@/lib/db-queries', () => ({
  logEvent: async (e: unknown) => {
    logged.push(e)
  },
}))

beforeEach(() => {
  logged.length = 0
})

const post = async (body: string, headers: Record<string, string> = {}) => {
  const { POST } = await import('@/app/api/analytics/route')
  return POST(new Request('http://t/api/analytics', { method: 'POST', body, headers }))
}

describe('event metadata', () => {
  it('keeps small flat fields and drops everything else', () => {
    expect(
      cleanMetadata({ rating: 5, category: 'bug', ok: true, nested: { a: 1 }, list: [1], fn: null })
    ).toEqual({ rating: 5, category: 'bug', ok: true })
  })

  it('bounds the number of keys and the length of each string', () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'x'.repeat(500)]))
    const out = cleanMetadata(many)!
    expect(Object.keys(out)).toHaveLength(8)
    expect(Object.values(out).every((v) => String(v).length === 128)).toBe(true)
  })

  it('refuses arrays and primitives outright', () => {
    expect(cleanMetadata([1, 2])).toBeNull()
    expect(cleanMetadata('x')).toBeNull()
  })
})

describe('POST /api/analytics', () => {
  it('refuses a body larger than an event', async () => {
    const big = JSON.stringify({ event: 'page_view', metadata: { x: 'y'.repeat(10_000) } })
    const res = await post(big)
    expect(res.status).toBe(413)
    expect(logged).toHaveLength(0)
  })

  it('cannot shed its limit by rotating the session id', async () => {
    const ip = { 'cf-connecting-ip': '198.51.100.20' }
    let last = 0
    for (let i = 0; i < 125; i++) {
      const res = await post(JSON.stringify({ event: 'page_view', sessionId: `s-${i}` }), ip)
      last = res.status
    }
    expect(last).toBe(429)
  })

  it('stores a normal event', async () => {
    const res = await post(
      JSON.stringify({ event: 'feedback_submit', metadata: { rating: 4 } }),
      { 'cf-connecting-ip': '198.51.100.21' }
    )
    expect(res.status).toBe(200)
    expect(logged[0]).toMatchObject({ event: 'feedback_submit', metadata: { rating: 4 } })
  })
})
