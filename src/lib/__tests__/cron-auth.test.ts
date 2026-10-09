import { describe, it, expect, vi } from 'vitest'
import { cronAuthorized } from '../cron-auth'

const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers })

describe('cron authorization', () => {
  it('accepts the secret as a bearer token', () => {
    expect(cronAuthorized(req('http://t/api/cron/settle', { authorization: 'Bearer s3cret' }), 's3cret')).toBe('header')
  })

  it('refuses a wrong one, or none, or any when no secret is configured', () => {
    expect(cronAuthorized(req('http://t/x', { authorization: 'Bearer nope' }), 's3cret')).toBeNull()
    expect(cronAuthorized(req('http://t/x'), 's3cret')).toBeNull()
    expect(cronAuthorized(req('http://t/x', { authorization: 'Bearer ' }), '')).toBeNull()
  })

  it('still takes the query form, and says so in the log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(cronAuthorized(req('http://t/api/cron/monitor?secret=s3cret'), 's3cret')).toBe('query')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Authorization: Bearer'))
    warn.mockRestore()
  })
})
