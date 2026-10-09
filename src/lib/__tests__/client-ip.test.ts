import { describe, it, expect } from 'vitest'
import { getClientIp, isJsonRequest } from '../anti-spam'

// Every per-IP limit on the public forms keys on this. The first entry of
// X-Forwarded-For is whatever the client wrote; Cloudflare appends after it.

const req = (headers: Record<string, string>) =>
  new Request('http://t/api', { method: 'POST', headers })

describe('the client address', () => {
  it('takes Cloudflare s connecting address over anything forwarded', () => {
    expect(
      getClientIp(req({ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '1.2.3.4, 198.51.100.7' }))
    ).toBe('198.51.100.7')
  })

  it('takes the hop our proxy appended, not the one the client wrote', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }))).toBe('203.0.113.9')
  })

  it('cannot be rotated by rewriting the forwarded list', () => {
    const a = getClientIp(req({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9' }))
    const b = getClientIp(req({ 'x-forwarded-for': '2.2.2.2, 203.0.113.9' }))
    expect(a).toBe(b)
  })

  it('falls back to x-real-ip, then to nothing', () => {
    expect(getClientIp(req({ 'x-real-ip': '192.0.2.1' }))).toBe('192.0.2.1')
    expect(getClientIp(req({}))).toBeNull()
  })
})

describe('a JSON body is declared, not assumed', () => {
  it('accepts application/json, with or without a charset', () => {
    expect(isJsonRequest(req({ 'content-type': 'application/json' }))).toBe(true)
    expect(isJsonRequest(req({ 'content-type': 'application/json; charset=utf-8' }))).toBe(true)
  })

  it('refuses the text/plain a cross-site form can send without a preflight', () => {
    expect(isJsonRequest(req({ 'content-type': 'text/plain' }))).toBe(false)
    expect(isJsonRequest(req({}))).toBe(false)
  })
})
