import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'

// Production went down on exactly this: DB_SSL_CA pasted into a dashboard
// that kept it on one line, so the pool verified against nothing and every
// query failed 'self-signed certificate in certificate chain'. The fixture is
// Supabase's public root CA, the certificate that variable holds.

vi.mock('pg', () => ({ Pool: class {} }))
const { normalizePem, sslConfig } = await import('../db')

const PEM = readFileSync(join(__dirname, 'fixtures/supabase-prod-ca-2021.crt'), 'utf8')

function parses(pem: string): string {
  return new X509Certificate(pem).subject
}

describe('normalizePem', () => {
  it('leaves a well-formed certificate as it was', () => {
    expect(normalizePem(PEM)).toBe(PEM.trim() + '\n')
  })

  it.each([
    ['line breaks turned into spaces', PEM.replace(/\n/g, ' ')],
    ['line breaks escaped as \\n', PEM.replace(/\n/g, '\\n')],
    ['wrapped in quotes', `"${PEM}"`],
    ['CRLF line endings', PEM.replace(/\n/g, '\r\n')],
    ['the body on one line', PEM.replace(/\n(?!-----)/g, '').replace('-----\n', '-----')],
  ])('recovers the certificate from %s', (_, mangled) => {
    expect(parses(normalizePem(mangled))).toContain('Supabase Root 2021 CA')
  })

  it('passes through text with no PEM in it, so the caller can say so', () => {
    expect(normalizePem('PASTE_CA_HERE')).toBe('PASTE_CA_HERE')
  })
})

describe('sslConfig', () => {
  const POOLER = 'postgresql://u:p@aws-1-us-west-1.pooler.supabase.com:6543/postgres'
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('verifies a Supabase host against the bundled root with nothing configured', () => {
    vi.stubEnv('DATABASE_URL', POOLER)
    vi.stubEnv('DB_SSL_CA', undefined as any)
    const c = sslConfig() as { ca: string[]; rejectUnauthorized: boolean }
    expect(c.rejectUnauthorized).toBe(true)
    expect(c.ca.map(parses)).toEqual([expect.stringContaining('Supabase Root 2021 CA')])
  })

  it('ignores a DB_SSL_CA that holds nothing, instead of letting it replace the root', () => {
    vi.stubEnv('DATABASE_URL', POOLER)
    vi.stubEnv('DB_SSL_CA', 'PASTE_CA_HERE')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const c = sslConfig() as { ca: string[] }
    expect(c.ca).toHaveLength(1)
    expect(parses(c.ca[0])).toContain('Supabase Root 2021 CA')
    expect(err).toHaveBeenCalledOnce()
  })

  it('ignores a DB_SSL_CA whose base64 is corrupt', () => {
    vi.stubEnv('DATABASE_URL', POOLER)
    vi.stubEnv('DB_SSL_CA', PEM.replace(/MIID/, 'XXXX'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((sslConfig() as { ca: string[] }).ca).toHaveLength(1)
  })

  it('adds a valid DB_SSL_CA alongside the root', () => {
    vi.stubEnv('DATABASE_URL', POOLER)
    vi.stubEnv('DB_SSL_CA', PEM.replace(/\n/g, ' '))
    expect((sslConfig() as { ca: string[] }).ca).toHaveLength(2)
  })

  it('leaves a non-Supabase host to the flag when no CA is given', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/test')
    vi.stubEnv('DB_SSL_CA', undefined as any)
    vi.stubEnv('DB_SSL_REJECT_UNAUTHORIZED', 'false')
    expect(sslConfig()).toEqual({ rejectUnauthorized: false })
  })

  it('does not mistake a password containing supabase.com for the host', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://u:x.supabase.com@localhost:5432/test')
    vi.stubEnv('DB_SSL_CA', undefined as any)
    vi.stubEnv('DB_SSL_REJECT_UNAUTHORIZED', 'false')
    expect(sslConfig()).toEqual({ rejectUnauthorized: false })
  })
})

describe('TLS settings in the connection string', () => {
  // node-postgres lets URL parameters override the ssl object beside them.
  it('are removed, so the pool s own verification stands', async () => {
    const { withoutUrlTls } = await import('../db')
    const out = withoutUrlTls(
      'postgresql://u:p@db.example.supabase.com:6543/postgres?sslmode=no-verify&application_name=lusty&sslrootcert=/tmp/x'
    )
    expect(out).not.toMatch(/sslmode|sslrootcert/)
    expect(out).toContain('application_name=lusty')
    expect(out).toContain('u:p@db.example.supabase.com:6543/postgres')
  })

  it('leaves a string it cannot parse alone', async () => {
    const { withoutUrlTls } = await import('../db')
    expect(withoutUrlTls('not a url')).toBe('not a url')
  })
})
