import { getPool, ensureSchema } from './db'
import { getClientIp } from './anti-spam'

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

export type RateLimitResult = { ok: true } | { ok: false; retryAfter: number }

/**
 * Simple in-memory sliding-window rate limiter.
 * Returns { ok: true } if under limit, or { ok: false, retryAfter } if over.
 *
 * Per process: it resets on every deploy and does not exist across replicas.
 * Fine for shedding load on a read endpoint; not a bound an attacker respects.
 * Anything that guards money, an admin door or a paid upstream uses
 * durableRateLimit below.
 */
export function rateLimit(
  key: string,
  windowMs: number,
  maxRequests: number
): RateLimitResult {
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

/**
 * A limit per client and a ceiling over everyone, both in memory.
 *
 * A single shared key is a switch any one client can flip: spend the bucket and
 * every other visitor is refused until it refills. Keyed per client address
 * (lib/anti-spam), one client spends only its own allowance, and the ceiling
 * still bounds what the route asks of whatever sits behind it.
 */
export function clientRateLimit(
  req: Request,
  scope: string,
  windowMs: number,
  perClient: number,
  /** Omit when the caller enforces its own ceiling, e.g. a durable one. */
  overall?: number
): RateLimitResult {
  const ip = getClientIp(req) ?? 'anon'
  const mine = rateLimit(`${scope}:ip:${ip}`, windowMs, perClient)
  if (!mine.ok || overall === undefined) return mine
  return rateLimit(`${scope}:all`, windowMs, overall)
}

/**
 * The sliding-window-counter estimate: the previous window's count, weighted
 * by how much of it still overlaps a window ending now, plus the current
 * window's count. Two integers per key instead of a timestamp per hit, which
 * is what lets the count live in one database row that every replica shares.
 *
 * `prev` and `cur` exclude the request being decided. Returns whether it fits,
 * and if not, the seconds until it would.
 */
export function slidingWindowDecision(
  prev: number,
  cur: number,
  elapsedMs: number,
  windowMs: number,
  max: number
): RateLimitResult {
  const f = elapsedMs / windowMs
  if (prev * (1 - f) + cur + 1 <= max) return { ok: true }

  // Still in this window: prev's weight shrinks as f grows, cur stays.
  // Solve prev·(1−f′) + cur + 1 ≤ max for f′.
  if (max - cur - 1 >= 0 && prev > 0) {
    const fNeeded = 1 - (max - cur - 1) / prev
    return { ok: false, retryAfter: Math.max(1, Math.ceil(((fNeeded - f) * windowMs) / 1000)) }
  }
  // Not before the window rolls over, when cur becomes the weighted one.
  const fNext = cur > 0 ? Math.max(0, 1 - (max - 1) / cur) : 0
  return { ok: false, retryAfter: Math.max(1, Math.ceil(((1 - f + fNext) * windowMs) / 1000)) }
}

let warnedFallback = false

/**
 * A rate limit that survives a deploy and holds across replicas.
 *
 * The in-memory limiter bounds an honest client: an attacker resets it by
 * waiting for a deploy, or never meets it by landing on a different process.
 * This one keeps its counts in Postgres, one row per key per window, so every
 * process reads and writes the same number.
 *
 * The local limiter still runs first. It is free, it sheds a flood before it
 * reaches the database, and it is what remains if the database cannot be
 * reached — in which case this degrades to exactly the old behaviour, logged,
 * rather than failing the request. The routes behind this already fail closed
 * on their own durable checks (the faucet's caps, the breaker, the quote
 * policy), so a missing count here loosens a first line, not the last one.
 *
 * Only accepted requests are counted, as the local limiter does: a client that
 * keeps knocking while limited is not pushed further back for knocking.
 */
export async function durableRateLimit(
  key: string,
  windowMs: number,
  maxRequests: number
): Promise<RateLimitResult> {
  // The window is part of the key, so two call sites that share a key but not
  // a window cannot read each other's counts as their own.
  const k = `${key}@${windowMs}`
  const local = rateLimit(k, windowMs, maxRequests)
  if (!local.ok) return local
  if (!process.env.DATABASE_URL) return local

  const now = Date.now()
  const bucket = Math.floor(now / windowMs)
  const elapsed = now - bucket * windowMs

  try {
    await ensureSchema()
    const pool = getPool()
    const { rows } = await pool.query(
      `select bucket, hits from rate_limits where key = $1 and bucket in ($2, $3)`,
      [k, bucket, bucket - 1]
    )
    const count = (b: number) => Number(rows.find((r: any) => Number(r.bucket) === b)?.hits ?? 0)
    const decision = slidingWindowDecision(count(bucket - 1), count(bucket), elapsed, windowMs, maxRequests)
    if (!decision.ok) return decision

    // Read then write, so two replicas can both admit the last slot. The
    // overshoot is bounded by the number of replicas racing on one key in one
    // instant, which is a rounding error on the limits this guards.
    await pool.query(
      `insert into rate_limits (key, bucket, hits, expires_at)
       values ($1, $2, 1, to_timestamp($3 / 1000.0))
       on conflict (key, bucket) do update set hits = rate_limits.hits + 1`,
      [k, bucket, (bucket + 2) * windowMs]
    )
    // Expired rows are swept by whoever happens to be writing, now and then,
    // so the table stays the size of the live windows without a cron.
    if (Math.random() < 0.01) {
      pool.query(`delete from rate_limits where expires_at < now()`).catch(() => {})
    }
    return { ok: true }
  } catch (err) {
    if (!warnedFallback) {
      warnedFallback = true
      console.warn('rate-limit: durable store unavailable, falling back to per-process limits', err)
    }
    return local
  }
}
