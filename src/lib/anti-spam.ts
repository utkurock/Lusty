// Shared anti-spam helpers for public, unauthenticated endpoints (feedback,
// analytics). All checks are best-effort and fail open on the IP side: if we
// cannot read a client IP we fall back to a shared bucket rather than blocking
// everyone. Content heuristics fail closed (spam-looking input is rejected).

/**
 * Best-effort client IP. Behind Vercel/most proxies the real client is the
 * first hop in `x-forwarded-for`; `x-real-ip` is a common fallback. Returns
 * null when nothing usable is present (local dev, missing headers).
 */
export function getClientIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }
  const real = req.headers.get('x-real-ip')?.trim()
  if (real) return real
  return null
}

const URL_RE = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|xyz|ru|top|info|biz|live|click|shop)\b/gi

/**
 * Cheap content heuristic for link-spam. Genuine feedback rarely contains
 * more than one link; bots paste several. Returns a reason string when the
 * message looks like spam, or null when it passes.
 */
export function spamReason(message: string): string | null {
  const matches = message.match(URL_RE)
  const linkCount = matches ? matches.length : 0
  if (linkCount >= 3) return 'too many links'

  // Mostly-link messages (a couple of words wrapped around a URL) are almost
  // always spam — flag when links dominate the (short) message.
  const words = message.trim().split(/\s+/).filter(Boolean)
  if (linkCount >= 1 && words.length <= 4) return 'link-only message'

  return null
}
