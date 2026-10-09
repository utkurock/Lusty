import { describe, it, expect, vi, beforeEach } from 'vitest'

// The adversarial window's on-site report form. What it has to get right: a
// report is stored before anything else can fail, the maintainers are told
// at the urgency the reporter claimed, nothing reads the reports without an
// admin session, and the window's dates decide whether the form is offered.

const inserted = vi.hoisted(() => [] as unknown[])
const alerts = vi.hoisted(() => [] as any[])
const alertFails = vi.hoisted(() => ({ value: false }))
const limited = vi.hoisted(() => ({ value: false }))

vi.mock('@/lib/db-queries', () => ({
  insertSecurityReport: async (r: unknown) => {
    inserted.push(r)
    return 7
  },
  getSecurityReports: async () => ({ rows: [], total: 0, urgent: 0 }),
  isAdmin: async () => true,
}))

vi.mock('@/lib/rate-limit', () => ({
  durableRateLimit: async () => (limited.value ? { ok: false, retryAfter: 60 } : { ok: true }),
}))

vi.mock('@/lib/monitor/notify', () => ({
  sendAlert: async (a: unknown) => {
    alerts.push(a)
    if (alertFails.value) throw new Error('slack down')
    return { delivered: true, results: [] }
  },
}))

const validate = vi.hoisted(() => vi.fn<(token: string) => string | null>())
vi.mock('@/lib/admin-sessions', () => ({ validateSession: validate, revokeSession: () => {} }))

beforeEach(() => {
  inserted.length = 0
  alerts.length = 0
  alertFails.value = false
  limited.value = false
  validate.mockReset()
})

const REPORT = {
  severity: 'high',
  attackClass: 8,
  book: 'BTC',
  summary: '  Claim the same position twice  ',
  reproduction: '1. open\n2. settle\n3. settle again',
  transactions: 'abc123',
  expected: 'The second settle is refused',
  actual: 'It paid out again',
  contact: 'someone@example.com',
  credit: '',
  elapsedMs: 60_000,
}

async function post(body: unknown, headers: Record<string, string> = {}) {
  const { POST } = await import('@/app/api/security-report/route')
  return POST(
    new Request('http://localhost/api/security-report', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  )
}

describe('POST /api/security-report', () => {
  it('stores a report, hands back its reference and pages at the claimed urgency', async () => {
    const res = await post(REPORT, { 'x-forwarded-for': '203.0.113.9' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, ref: 'LSR-007' })

    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      severity: 'high',
      attackClass: 8,
      book: 'BTC',
      summary: 'Claim the same position twice',
      credit: null,
      ip: '203.0.113.9',
    })

    expect(alerts).toHaveLength(1)
    // High promises a same-day acknowledgement, so it pages like a critical.
    expect(alerts[0].severity).toBe('critical')
    expect(alerts[0].title).toContain('LSR-007')
    // The reproduction stays in the database, out of the notification.
    expect(JSON.stringify(alerts[0])).not.toContain('settle again')
  })

  it('pages a Low as info', async () => {
    await post({ ...REPORT, severity: 'low' })
    expect(alerts[0].severity).toBe('info')
  })

  it('still answers success when the notification fails, because the report is stored', async () => {
    alertFails.value = true
    const res = await post(REPORT)
    expect(res.status).toBe(200)
    expect(inserted).toHaveLength(1)
  })

  it.each([
    ['severity', { severity: 'urgent' }],
    ['contact', { contact: '   ' }],
    ['reproduction', { reproduction: '' }],
    ['attackClass', { attackClass: 20 }],
    ['book', { book: 'ETH' }],
    ['summary', { summary: 'x'.repeat(201) }],
  ])('refuses a report with a bad %s and stores nothing', async (field, patch) => {
    const res = await post({ ...REPORT, ...patch })
    expect(res.status).toBe(400)
    expect((await res.json()).field).toBe(field)
    expect(inserted).toHaveLength(0)
    expect(alerts).toHaveLength(0)
  })

  it('accepts a report with no class or book — "not sure" is a valid answer', async () => {
    const res = await post({ ...REPORT, attackClass: null, book: '' })
    expect(res.status).toBe(200)
    expect(inserted[0]).toMatchObject({ attackClass: null, book: null })
  })

  it('answers a filled honeypot or an instant submit with a fake success and stores nothing', async () => {
    for (const trap of [{ website: 'http://spam' }, { elapsedMs: 200 }]) {
      const res = await post({ ...REPORT, ...trap })
      expect(res.status).toBe(200)
    }
    expect(inserted).toHaveLength(0)
    expect(alerts).toHaveLength(0)
  })

  it('refuses past the rate limit', async () => {
    limited.value = true
    const res = await post(REPORT)
    expect(res.status).toBe(429)
    expect(inserted).toHaveLength(0)
  })
})

describe('GET /api/admin/security-reports is admin only', () => {
  async function get(headers: Record<string, string> = {}) {
    const { GET } = await import('@/app/api/admin/security-reports/route')
    return GET(new Request('http://localhost/api/admin/security-reports', { headers }))
  }

  it('refuses a request with no session', async () => {
    expect((await get()).status).toBe(403)
  })

  it('refuses a token no session knows', async () => {
    validate.mockReturnValue(null)
    expect((await get({ 'x-admin-token': 'nope' })).status).toBe(401)
  })

  it('answers an admin session', async () => {
    validate.mockReturnValue('GADMIN')
    const res = await get({ 'x-admin-token': 'real' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, total: 0, urgent: 0 })
  })
})

describe('the window', () => {
  it('is open from its first second to its last, and only then', async () => {
    const { windowState, WINDOW_OPENS, WINDOW_CLOSES } = await import('@/lib/adversarial')
    const opens = Date.parse(WINDOW_OPENS)
    const closes = Date.parse(WINDOW_CLOSES)
    expect(windowState(opens - 1)).toBe('before')
    expect(windowState(opens)).toBe('open')
    expect(windowState(closes)).toBe('open')
    expect(windowState(closes + 1000)).toBe('closed')
  })

  it('names the same nineteen classes docs/ADVERSARIAL.md does', async () => {
    const { readFileSync } = await import('node:fs')
    const { ATTACK_CLASSES } = await import('@/lib/adversarial')
    const doc = readFileSync('docs/ADVERSARIAL.md', 'utf8')
    const headings = [...doc.matchAll(/^\s*(\d+)\. \*\*(.+?)\.\*\*/gm)]
      .filter(([, n]) => Number(n) >= 1 && Number(n) <= 19)
      .slice(0, 19)
      .map(([, , name]) => name)
    expect(headings).toEqual([...ATTACK_CLASSES])
  })

  it('carries the same dates as docs/ADVERSARIAL.md', async () => {
    const { readFileSync } = await import('node:fs')
    const doc = readFileSync('docs/ADVERSARIAL.md', 'utf8')
    expect(doc).toContain('open from 2026-10-06 00:00 UTC to 2026-10-20 23:59 UTC')
  })
})
