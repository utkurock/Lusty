import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The in-memory sweeper cut every key at ten minutes, whatever window it was
// counted over, so an hourly limit forgot its first hits ten minutes in and
// `connect:hour` allowed 30 per ten minutes rather than per hour.

const HOUR = 3_600_000
const T0 = 1_800_000_000_000

let rl: typeof import('../rate-limit')

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  rl = await import('../rate-limit')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the sweeper keeps each key for its own window', () => {
  it('still refuses an hourly key twenty minutes in, across a sweep', () => {
    for (let i = 0; i < 3; i++) expect(rl.rateLimit('hourly', HOUR, 3).ok).toBe(true)

    vi.setSystemTime(T0 + 20 * 60_000)
    rl.sweepRateLimits()

    const after = rl.rateLimit('hourly', HOUR, 3)
    expect(after.ok).toBe(false)
    if (!after.ok) expect(after.retryAfter).toBe(40 * 60)
  })

  it('lets the hourly key go once its own hour has passed', () => {
    for (let i = 0; i < 3; i++) rl.rateLimit('hourly-2', HOUR, 3)
    vi.setSystemTime(T0 + HOUR + 1)
    rl.sweepRateLimits()
    expect(rl.rateLimit('hourly-2', HOUR, 3).ok).toBe(true)
  })

  it('still forgets a short window once it has passed', () => {
    rl.rateLimit('minute', 60_000, 1)
    vi.setSystemTime(T0 + 61_000)
    rl.sweepRateLimits()
    expect(rl.rateLimit('minute', 60_000, 1).ok).toBe(true)
  })

  it('holds the per-client hourly connect limit for the whole hour', () => {
    const req = () => new Request('http://t/api', { headers: { 'cf-connecting-ip': '198.51.100.40' } })
    for (let i = 0; i < 30; i++) {
      vi.setSystemTime(T0 + i * 60_000)
      expect(rl.clientRateLimit(req(), 'connect:hour', HOUR, 30).ok).toBe(true)
    }
    vi.setSystemTime(T0 + 45 * 60_000)
    rl.sweepRateLimits()
    expect(rl.clientRateLimit(req(), 'connect:hour', HOUR, 30).ok).toBe(false)
  })
})
