import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'

// Production went down on exactly this: DB_SSL_CA pasted into a dashboard
// that kept it on one line, so the pool verified against nothing and every
// query failed 'self-signed certificate in certificate chain'. The fixture is
// Supabase's public root CA, the certificate that variable holds.

vi.mock('pg', () => ({ Pool: class {} }))
const { normalizePem } = await import('../db')

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
