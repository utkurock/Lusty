import { createHash, timingSafeEqual } from 'crypto'

// One way to authorize a scheduled job, shared by /api/cron/monitor and
// /api/cron/settle.
//
// Compared in constant time, on digests so the two sides are always the same
// length. `!==` stops at the first differing byte, which is a timing signal for
// anybody patient enough to measure it.
//
// The header is the credential. `?secret=` is still accepted because a
// deployment's scheduler may have been configured with it, and refusing it
// outright would stop the risk monitor without a word — but a query string
// lands in proxy and access logs, so every use of it is logged as something to
// move off.

function same(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest()
  const db = createHash('sha256').update(b).digest()
  return timingSafeEqual(da, db)
}

export type CronAuth = 'header' | 'query' | null

export function cronAuthorized(req: Request, secret: string): CronAuth {
  if (!secret) return null
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (bearer && same(bearer, secret)) return 'header'
  const qs = new URL(req.url).searchParams.get('secret') ?? ''
  if (qs && same(qs, secret)) {
    console.warn(
      `${new URL(req.url).pathname}: CRON_SECRET arrived in the query string, which access logs keep. Send it as "Authorization: Bearer <secret>" instead.`
    )
    return 'query'
  }
  return null
}
