import { ensureSchema, getPool } from '@/lib/db'
import { positionKey } from '@/lib/settlement'
import type { UnderlyingSymbol } from '@/lib/assets'
import type { Alert } from './notify'

/**
 * Every settle that failed, reported when it fails.
 *
 * The backlog check already notices expired positions that are not settled,
 * and it is the right check for a sweep that has fallen behind. But it is a
 * count, read off the chain: it says four positions are due, not that one of
 * them has been refused by the contract eleven times with the same error. A
 * settle that fails for a reason no retry will fix — the owner dropped the
 * trustline the payout needs, the pool cannot cover what is owed — looks
 * exactly like a sweep running slightly late, until the oracle window closes
 * and it stops looking like anything at all.
 *
 * The run log (M3-02) already carries each run's failures, so this reads them
 * rather than adding a second record. Two rules keep it from becoming noise:
 *
 *   • A failure is reported when it is NEW — present in the latest run and not
 *     in the one before it. A position failing identically every run has
 *     already been reported once, and from there it is the backlog check's,
 *     with its deadline.
 *   • A run is read once. The monitor ticks more often than the sweep, and the
 *     same run's failures must not be reported on every tick.
 */

const CURSOR_NAME = 'settle-failures'

export interface RecordedFailure {
  id: number
  underlying: UnderlyingSymbol
  vault: string
  error: string
  permanent: boolean
}

const keyOf = (f: RecordedFailure) => `${f.vault}#${f.id}`

/** Failures in `latest` that were not already failing in `previous`. */
export function newFailures(
  latest: RecordedFailure[],
  previous: RecordedFailure[],
): RecordedFailure[] {
  const before = new Set(previous.map(keyOf))
  return latest.filter((f) => !before.has(keyOf(f)))
}

/** The alert for a batch of fresh failures, or null when there were none. Pure. */
export function settleFailureAlert(
  failures: RecordedFailure[],
  runFinishedAt: string | null,
): Alert | null {
  if (failures.length === 0) return null
  const permanent = failures.filter((f) => f.permanent)
  const lines = failures.map((f) => {
    const what = f.permanent ? 'permanently unsettleable' : 'failed, will retry'
    return `${positionKey(f.underlying, f.id, f.vault)}: ${what} — ${f.error}`
  })

  return {
    severity: permanent.length > 0 ? 'critical' : 'warning',
    title:
      permanent.length > 0
        ? 'Settlement refused and no retry will help'
        : 'Settle transaction failed',
    message:
      `${failures.length} position(s) failed to settle in the run that finished at ` +
      `${runFinishedAt ?? 'an unrecorded time'}. ${lines.join('. ')}.` +
      (permanent.length > 0
        ? ' A permanent failure is a decision, not a retry: the contract will refuse it the ' +
          'same way every run until the oracle window closes, after which the thirty-day ' +
          'release is the only way the collateral comes back.'
        : ' The next sweep will try again; this is reported now because a position inside its ' +
          'oracle window has a deadline.'),
    fields: [
      { label: 'failed', value: String(failures.length) },
      { label: 'permanent', value: String(permanent.length) },
      ...failures.map((f) => ({
        label: positionKey(f.underlying, f.id, f.vault),
        value: f.error.slice(0, 200),
      })),
    ],
  }
}

/** The failures a run recorded, from its `detail` column. */
function failuresOf(detail: unknown): RecordedFailure[] {
  const parsed = typeof detail === 'string' ? JSON.parse(detail) : detail
  const list = (parsed as { failed?: unknown })?.failed
  return Array.isArray(list) ? (list as RecordedFailure[]) : []
}

export async function checkSettleFailures(): Promise<Alert | null> {
  try {
    await ensureSchema()
    const pool = getPool()
    // The two most recent completed runs: the latest for what failed, the one
    // before it for what was already failing.
    const { rows } = await pool.query(
      `select id, finished_at, detail from settlement_runs
        where finished_at is not null and outcome <> 'error'
        order by finished_at desc limit 2`,
    )
    if (rows.length === 0) return null

    const [latest, previous] = rows
    const { rows: cursorRows } = await pool.query(
      `select cursor from event_cursors where name = $1`,
      [CURSOR_NAME],
    )
    // Already read: the monitor ticks more often than the sweep runs.
    if (cursorRows[0]?.cursor === String(latest.id)) return null
    await pool.query(
      `insert into event_cursors (name, cursor) values ($1, $2)
       on conflict (name) do update set cursor = excluded.cursor, updated_at = now()`,
      [CURSOR_NAME, String(latest.id)],
    )

    return settleFailureAlert(
      newFailures(failuresOf(latest.detail), previous ? failuresOf(previous.detail) : []),
      latest.finished_at ? new Date(latest.finished_at).toISOString() : null,
    )
  } catch (e: any) {
    return {
      severity: 'critical',
      title: 'Settlement failure watch failed',
      message: `Could not read the settlement run log's failures: ${e?.message ?? 'unknown'}. A settle refused since the last run would go unreported.`,
    }
  }
}
