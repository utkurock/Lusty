import { describe, it, expect, vi, beforeEach } from 'vitest'

// The public intake routes read their body whole before any limiter ran, and
// Next caps nothing for an App Router handler: a chunked body with no
// Content-Length landed in the heap in full. Each now refuses past its cap
// with 413, as the bytes arrive, before anything is counted or parsed.

const limiterKeys = vi.hoisted(() => [] as string[])
const writes = vi.hoisted(() => [] as string[])

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: (key: string) => {
    limiterKeys.push(key)
    return { ok: true }
  },
  clientRateLimit: (_req: Request, scope: string) => {
    limiterKeys.push(scope)
    return { ok: true }
  },
  durableRateLimit: async (key: string) => {
    limiterKeys.push(key)
    return { ok: true }
  },
}))

vi.mock('@/lib/db-queries', () => ({
  logEvent: async () => void writes.push('analytics'),
  insertFeedback: async () => void writes.push('feedback'),
  isDuplicateFeedback: async () => false,
  insertSecurityReport: async () => {
    writes.push('security-report')
    return 1
  },
  upsertUser: async () => void writes.push('user'),
  isAdmin: async () => true,
}))

vi.mock('@/lib/monitor/notify', () => ({ sendAlert: async () => ({ delivered: true, results: [] }) }))

vi.mock('@/lib/admin-sessions', () => ({
  createChallenge: () => ({ challengeId: 'c1', nonce: 'n'.repeat(64) }),
  consumeChallenge: () => ({ address: 'GADMIN', nonce: 'n'.repeat(64), expiresAt: Date.now() + 60_000 }),
  createSession: () => 'token',
  revokeSession: () => {},
}))

vi.mock('@/lib/routing/session', () => ({
  prepareRoutedSwap: async () => {
    writes.push('routing')
    return {}
  },
  settleRoutedSwap: async () => {
    writes.push('routing')
    return { filled: false, reason: 'x' }
  },
  RoutedSwapRefused: class extends Error {},
}))

beforeEach(() => {
  limiterKeys.length = 0
  writes.length = 0
})

/** A JSON-typed POST whose body is streamed in chunks with no Content-Length. */
function chunkedPost(path: string, totalBytes: number, headers: Record<string, string> = {}) {
  // Whitespace: valid JSON padding, so only the size can be what refuses it.
  const chunk = new Uint8Array(1024).fill(0x20)
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) return controller.close()
      sent += chunk.byteLength
      controller.enqueue(chunk)
    },
  })
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    duplex: 'half',
  } as RequestInit)
}

const ROUTES: [string, () => Promise<{ POST: (req: Request) => Promise<Response> }>, number][] = [
  ['/api/analytics', () => import('@/app/api/analytics/route'), 8 * 1024],
  ['/api/feedback', () => import('@/app/api/feedback/route'), 128 * 1024],
  ['/api/security-report', () => import('@/app/api/security-report/route'), 128 * 1024],
  ['/api/users/connect', () => import('@/app/api/users/connect/route'), 128 * 1024],
  ['/api/admin/auth', () => import('@/app/api/admin/auth/route'), 128 * 1024],
  ['/api/routing/swap', () => import('@/app/api/routing/swap/route'), 128 * 1024],
]

describe('public intake refuses an oversized streamed body with 413', () => {
  it.each(ROUTES)('%s', async (path, load, size) => {
    const { POST } = await load()
    const res = await POST(chunkedPost(path, size, { 'cf-connecting-ip': '198.51.100.90' }))
    expect(res.status).toBe(413)
    // Refused before any limiter was charged and before anything was written.
    expect(limiterKeys).toEqual([])
    expect(writes).toEqual([])
  })

  it('still takes a small analytics event', async () => {
    const { POST } = await import('@/app/api/analytics/route')
    const res = await POST(
      new Request('http://localhost/api/analytics', {
        method: 'POST',
        body: JSON.stringify({ event: 'page_view' }),
        headers: { 'cf-connecting-ip': '198.51.100.91' },
      }),
    )
    expect(res.status).toBe(200)
    expect(writes).toEqual(['analytics'])
  })
})

describe('feedback without a readable client address', () => {
  it('is held to the shared anon bucket rather than skipping the IP layer', async () => {
    const { POST } = await import('@/app/api/feedback/route')
    const res = await POST(
      new Request('http://localhost/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'the chart is lovely', elapsedMs: 10_000 }),
      }),
    )
    expect(res.status).toBe(200)
    expect(limiterKeys).toContain('feedback:ip:anon')
    expect(limiterKeys).toContain('feedback:ip:daily:anon')
  })
})

describe('admin auth does not hand an anonymous caller its error text', () => {
  it('answers a malformed signed envelope with a reference, not the parser message', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { POST } = await import('@/app/api/admin/auth/route')
    const res = await POST(
      new Request('http://localhost/api/admin/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.92' },
        body: JSON.stringify({ action: 'verify', challengeId: 'c1', signedXdr: 'not-xdr' }),
      }),
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('auth failed')
    expect(body.detail).toBeUndefined()
    expect(body.ref).toMatch(/^ref [0-9a-f]{8}$/)
    err.mockRestore()
  })

  it('answers a body that is not JSON with 400', async () => {
    const { POST } = await import('@/app/api/admin/auth/route')
    const res = await POST(
      new Request('http://localhost/api/admin/auth', { method: 'POST', body: '{nope' }),
    )
    expect(res.status).toBe(400)
  })
})
