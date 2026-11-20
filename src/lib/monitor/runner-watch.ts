import { ensureSchema, getPool } from '@/lib/db'
import { ORACLE_HISTORY_SECS } from '@/lib/oracle-window'
import type { Alert } from './notify'

/**
 * Whether the settlement runner is running.
 *
 * Nothing watched this. The sweep logs every run, including the empty ones,
 * and the backlog check notices positions that have expired and not settled —
 * but a runner that stopped is invisible in both until an expiry has already
 * come due, and the window from there to unsettleable collateral is about a
 * day. The log says the runner ran; nothing said it had stopped.
 *
 * So each run writes a row before it starts and closes it when it ends, and
 * the monitor reads the last closed one. Two failures fall out of that shape
 * rather than needing their own checks: a run that never finished leaves its
 * row open, and a run that failed leaves its reason in the row.
 *
 * Recording is best-effort in both directions. A sweep must never fail to
 * settle because the bookkeeping database is unwell — the cost of not
 * settling is permanent and the cost of a missing row is a late alert.
 */

export type RunSource = 'scheduler' | 'endpoint'

export interface RunResult {
  outcome: 'ok' | 'error' | 'scan-only'
  settled: number
  failed: number
  due: number
  /** Whatever the run wants kept: failures, the error, the books it walked. */
  detail?: unknown
}

/** Opens a row for a run about to start. Null when it could not be written. */
export async function recordRunStart(source: RunSource): Promise<number | null> {
  try {
    await ensureSchema()
    const { rows } = await getPool().query(
      `insert into settlement_runs (source) values ($1) returning id`,
      [source],
    )
    return Number(rows[0].id)
  } catch (e: any) {
    console.warn('runner-watch: could not record the run start', e?.message ?? e)
    return null
  }
}

/** Closes the row `recordRunStart` opened. A null id is a no-op. */
export async function recordRunEnd(id: number | null, result: RunResult): Promise<void> {
  if (id === null) return
  try {
    await getPool().query(
      `update settlement_runs
          set finished_at = now(), outcome = $2, settled = $3, failed = $4, due = $5, detail = $6
        where id = $1`,
      [
        id,
        result.outcome,
        result.settled,
        result.failed,
        result.due,
        result.detail === undefined ? null : JSON.stringify(result.detail),
      ],
    )
  } catch (e: any) {
    console.warn('runner-watch: could not record the run outcome', e?.message ?? e)
  }
}

export interface RunnerState {
  /** The most recent run that finished, whatever its outcome. */
  lastFinishedAt: Date | null
  lastOutcome: string | null
  lastError: string | null
  /** A run that opened a row and never closed it, if there is one. */
  openSince: Date | null
  /** Runs ever recorded, so "never ran" is not read as "ran long ago". */
  total: number
}

// The interval the scheduler actually uses, read from the same variable, so a
// deployment that slows the sweep down does not start alerting on itself.
const INTERVAL_MS = Number(process.env.SETTLE_SWEEP_INTERVAL_MS ?? 15 * 60_000)
// Missing one run is a slow run; missing two is a runner that is not running.
const TOLERANCE = Number(process.env.MONITOR_RUNNER_TOLERANCE ?? 2)
// Past this much of the oracle's history window, a position that expires now
// has lost a serious share of the time it has to be settled in.
const CRITICAL_MS = (ORACLE_HISTORY_SECS * 1000) / 4

/** The alert for a runner's state, or null when it is keeping up. Pure. */
export function runnerHealthAlert(
  state: RunnerState,
  now: number = Date.now(),
  intervalMs: number = INTERVAL_MS,
): Alert | null {
  const minutes = (ms: number) => (ms / 60_000).toFixed(1)
  const fields: Alert['fields'] = [
    { label: 'interval_min', value: minutes(intervalMs) },
    { label: 'last_finished', value: state.lastFinishedAt?.toISOString() ?? '—' },
    { label: 'last_outcome', value: state.lastOutcome ?? '—' },
    { label: 'runs_recorded', value: String(state.total) },
  ]

  if (state.total === 0) {
    return {
      severity: 'critical',
      title: 'Settlement runner has never run',
      message:
        'No settlement run has been recorded. Either the sweep is not running here or it has ' +
        'never got far enough to write a row. Expired positions are released only by a sweep, ' +
        'and the window to settle one at its expiry price is about a day.',
      fields,
    }
  }

  // A row opened and never closed: the process died mid-run, or the run is
  // wedged. Either way no later run has completed, so this outranks lateness.
  if (state.openSince && now - state.openSince.getTime() > intervalMs * TOLERANCE) {
    const stuckFor = now - state.openSince.getTime()
    return {
      severity: 'critical',
      title: 'Settlement run started and never finished',
      message:
        `A run has been open since ${state.openSince.toISOString()} (${minutes(stuckFor)} minutes) ` +
        `and no run has completed since. The process is wedged or it died mid-sweep.`,
      fields: [...fields, { label: 'open_since', value: state.openSince.toISOString() }],
    }
  }

  const since = state.lastFinishedAt ? now - state.lastFinishedAt.getTime() : null
  if (since === null || since > intervalMs * TOLERANCE) {
    const late = since === null ? null : minutes(since)
    const critical = since === null || since > CRITICAL_MS
    return {
      severity: critical ? 'critical' : 'warning',
      title: critical ? 'Settlement runner has stopped' : 'Settlement runner is late',
      message:
        `The last completed settlement run was ${late === null ? 'never' : `${late} minutes ago`}, ` +
        `against a ${minutes(intervalMs)} minute interval. ` +
        (critical
          ? 'A position expiring now is losing the window it has to settle at its expiry price. ' +
            'Settlement is permissionless — anyone can settle what is due — but somebody has to.'
          : 'One missed run is slowness; this is two.'),
      fields,
    }
  }

  if (state.lastOutcome === 'error') {
    return {
      severity: 'warning',
      title: 'Last settlement run failed',
      message:
        `The run that finished at ${state.lastFinishedAt?.toISOString()} ended in an error: ` +
        `${state.lastError ?? 'no reason recorded'}. The next tick will try again.`,
      fields,
    }
  }

  return null
}

/** Read the runner's state and judge it. Never throws. */
export async function checkRunnerHealth(): Promise<Alert | null> {
  try {
    await ensureSchema()
    const { rows } = await getPool().query(
      `select
         (select count(*) from settlement_runs) as total,
         (select max(finished_at) from settlement_runs) as last_finished,
         (select min(started_at) from settlement_runs where finished_at is null) as open_since,
         (select outcome from settlement_runs where finished_at is not null
            order by finished_at desc limit 1) as last_outcome,
         (select detail from settlement_runs where finished_at is not null
            order by finished_at desc limit 1) as last_detail`,
    )
    const r = rows[0] ?? {}
    const detail = typeof r.last_detail === 'string' ? JSON.parse(r.last_detail) : r.last_detail
    return runnerHealthAlert({
      lastFinishedAt: r.last_finished ? new Date(r.last_finished) : null,
      lastOutcome: r.last_outcome ?? null,
      lastError: detail?.error ?? null,
      openSince: r.open_since ? new Date(r.open_since) : null,
      total: Number(r.total ?? 0),
    })
  } catch (e: any) {
    return {
      severity: 'critical',
      title: 'Settlement runner watch failed',
      message: `Could not read the settlement run log: ${e?.message ?? 'unknown'}. Whether the runner is running is unknown.`,
    }
  }
}
