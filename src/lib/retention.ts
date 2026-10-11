import { ensureSchema, getPool } from './db'

// Retention for analytics events.
// ===============================
// /api/analytics is a public, unauthenticated write, and every event it accepts
// was a permanent row. The per-client and overall limits bound how fast the
// table grows, not how large it gets: at the overall ceiling it gains millions
// of rows a day and keeps every one, with three indexes over them. What the
// admin screen reads off it is recent activity, so rows past the retention
// window are deleted.

/** How long an analytics event is kept when ANALYTICS_RETENTION_DAYS is unset. */
export const DEFAULT_ANALYTICS_RETENTION_DAYS = 90

/** Rows removed per statement, so no one delete holds locks for long. */
const BATCH_SIZE = 5_000

/** Statements per call, so one cron run does a bounded amount of work. */
const MAX_BATCHES = 20

/**
 * The retention window in days. A value that is not a positive number falls
 * back to the default rather than to zero: a typo in the environment must not
 * read as "keep nothing" and empty the table.
 */
export function analyticsRetentionDays(raw: string | undefined = process.env.ANALYTICS_RETENTION_DAYS): number {
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_ANALYTICS_RETENTION_DAYS
}

/**
 * Delete analytics events older than the retention window, in batches.
 *
 * At most MAX_BATCHES × BATCH_SIZE rows go per call. A backlog larger than that
 * — the first run against a table that has never been pruned — is worked down
 * over successive runs, and `more` says one is left.
 */
export async function purgeOldAnalyticsEvents(
  days: number = analyticsRetentionDays(),
): Promise<{ deleted: number; more: boolean }> {
  await ensureSchema()
  const pool = getPool()
  const interval = `${Math.max(1, Math.floor(days))} days`

  let deleted = 0
  for (let i = 0; i < MAX_BATCHES; i++) {
    const res = await pool.query(
      `delete from analytics_events
        where id in (
          select id from analytics_events
           where created_at < now() - $1::interval
           limit $2
        )`,
      [interval, BATCH_SIZE],
    )
    const n = res.rowCount ?? 0
    deleted += n
    if (n < BATCH_SIZE) return { deleted, more: false }
  }
  return { deleted, more: true }
}
