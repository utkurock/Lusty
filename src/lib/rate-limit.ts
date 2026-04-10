const hits = new Map<string, number[]>()

// Clean old entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 600_000
  for (const [key, timestamps] of hits) {
    const filtered = timestamps.filter((t) => t > cutoff)
    if (filtered.length === 0) hits.delete(key)
    else hits.set(key, filtered)
  }
}, 300_000)

/**
 * Simple in-memory sliding-window rate limiter.
 * Returns { ok: true } if under limit, or { ok: false, retryAfter } if over.
 */
export function rateLimit(
  key: string,
  windowMs: number,
  maxRequests: number
): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now()
  const cutoff = now - windowMs
  const timestamps = (hits.get(key) ?? []).filter((t) => t > cutoff)

  if (timestamps.length >= maxRequests) {
    const oldest = timestamps[0]
    const retryAfter = Math.ceil((oldest + windowMs - now) / 1000)
    return { ok: false, retryAfter }
  }

  timestamps.push(now)
  hits.set(key, timestamps)
  return { ok: true }
}
