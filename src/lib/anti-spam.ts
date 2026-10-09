// Shared anti-spam helpers for public, unauthenticated endpoints (feedback,
// analytics). All checks are best-effort and fail open on the IP side: if we
// cannot read a client IP we fall back to a shared bucket rather than blocking
// everyone. Content heuristics fail closed (spam-looking input is rejected).

/**
 * Best-effort client IP, from the one header a client cannot write.
 *
 * lusty.finance sits behind Cloudflare, which sets `CF-Connecting-IP` to the
 * address it accepted the connection from, overwriting whatever the client
 * sent. `X-Forwarded-For` is the opposite: Cloudflare appends to it, so its
 * FIRST entry is whatever the client put there, and keying a rate limit on that
 * let one client become any number of clients. When there is no Cloudflare
 * header, the LAST entry is the one our own proxy appended.
 *
 * This holds only while the origin answers Cloudflare alone. If it can be
 * reached directly, a client can send `CF-Connecting-IP` itself — restrict the
 * origin to Cloudflare's ranges.
 *
 * Returns null when nothing usable is present (local dev, missing headers).
 */
export function getClientIp(req: Request): string | null {
  const cf = req.headers.get('cf-connecting-ip')?.trim()
  if (cf) return cf
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const hops = xff.split(',').map((h) => h.trim()).filter(Boolean)
    const last = hops[hops.length - 1]
    if (last) return last
  }
  const real = req.headers.get('x-real-ip')?.trim()
  if (real) return real
  return null
}

/**
 * Whether a POST declared a JSON body. A cross-site page can make a visitor's
 * browser send `text/plain` without a preflight, and `req.json()` parses it all
 * the same; requiring the JSON type puts that request behind CORS, which this
 * API does not grant.
 */
export function isJsonRequest(req: Request): boolean {
  return (req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')
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
