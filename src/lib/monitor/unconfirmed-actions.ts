import { ensureSchema, getPool } from '@/lib/db'
import { explorerTxUrl } from '@/lib/stellar'
import type { Alert } from './notify'

/**
 * Idempotency rows left reserved and never confirmed.
 *
 * Every payout and every deposit index reserves its key in `processed_actions`
 * first and confirms it when the work is done; a refused payout releases it.
 * The row that does neither is the one nobody is told about: a swap or bridge
 * payout the network did not confirm in time (`holdUnconfirmed` keeps the
 * guard and writes down the payout hash), or a server that stopped between
 * reserving and paying. The caller was told "do not send again"; the guard
 * refuses every retry; and the only record is a row in the admin table that
 * nobody is paged about. Whether that user was paid is decided by one hash,
 * and somebody has to look it up.
 *
 * Every write here finishes inside a minute — a payout's own timeout is sixty
 * seconds — so a row still reserved past the window has stopped, not slowed.
 *
 * Each row is reported once, when it first crosses the window: nothing in this
 * application resolves a row, so reporting it on every tick would turn one
 * stuck payout into a page every five minutes until someone edits the
 * database. The count of everything still outstanding rides along on each
 * alert, so an old row is not forgotten either.
 */

const CURSOR_NAME = 'unconfirmed-actions'
const WINDOW_MIN = Number(process.env.MONITOR_UNCONFIRMED_ACTION_MINUTES ?? 10)

export interface UnconfirmedAction {
  actionType: 'deposit' | 'claim' | 'swap'
  sourceHash: string
  payoutHash: string | null
  reservedAt: string
}

function describe(a: UnconfirmedAction): string {
  if (a.actionType === 'swap') {
    return a.payoutHash
      ? `swap funded by ${a.sourceHash}: payout ${a.payoutHash} was submitted and never confirmed — ` +
          `if it is on ${explorerTxUrl(a.payoutHash)} the user was paid and the row should be ` +
          'confirmed; if it is not, it can no longer land and the row should be released so the user can retry'
      : `swap funded by ${a.sourceHash}: no payout was ever recorded — the server stopped between ` +
          'reserving and paying, so the funding was received and nothing has paid it'
  }
  if (a.actionType === 'deposit') {
    return `deposit ${a.sourceHash}: indexing stopped midway, and the row refuses every retry to record the position`
  }
  return `claim ${a.sourceHash}: reserved and never confirmed`
}

/** The alert for rows newly past the window, or null when there are none. Pure. */
export function unconfirmedActionsAlert(
  fresh: UnconfirmedAction[],
  outstanding: number,
  windowMin: number = WINDOW_MIN,
): Alert | null {
  if (fresh.length === 0) return null
  const payouts = fresh.filter((a) => a.actionType === 'swap')
  return {
    severity: payouts.length > 0 ? 'critical' : 'warning',
    title:
      payouts.length > 0
        ? 'Payout outcome unknown: reserved and never confirmed'
        : 'Idempotency row reserved and never confirmed',
    message:
      `${fresh.length} action(s) have been reserved for more than ${windowMin} minutes without ` +
      `being confirmed or released. ${fresh.map(describe).join('. ')}. ` +
      `${outstanding} row(s) are unconfirmed in all.`,
    fields: [
      { label: 'new', value: String(fresh.length) },
      { label: 'outstanding', value: String(outstanding) },
      ...fresh.slice(0, 10).map((a) => ({
        label: `${a.actionType}:${a.sourceHash.slice(0, 16)}`,
        value: `reserved ${a.reservedAt}${a.payoutHash ? `, payout ${a.payoutHash}` : ''}`,
      })),
    ],
  }
}

export async function checkUnconfirmedActions(): Promise<Alert | null> {
  try {
    await ensureSchema()
    const pool = getPool()
    const { rows: cursorRows } = await pool.query(
      `select cursor from event_cursors where name = $1`,
      [CURSOR_NAME],
    )
    const cursor: string | null = cursorRows[0]?.cursor ?? null
    // reserved_at travels as Postgres' own text so the cursor compares to the
    // microsecond; a JavaScript Date would round it and report a row twice.
    const { rows } = await pool.query(
      `select action_type, source_hash, payout_hash, reserved_at::text as reserved_at,
              reserved_at > coalesce($2::timestamptz, '-infinity') as is_new
         from processed_actions
        where confirmed_at is null
          and reserved_at < now() - make_interval(mins => $1)
        order by reserved_at`,
      [WINDOW_MIN, cursor],
    )
    const fresh: UnconfirmedAction[] = rows
      .filter((r: any) => r.is_new)
      .map((r: any) => ({
        actionType: r.action_type,
        sourceHash: r.source_hash,
        payoutHash: r.payout_hash ?? null,
        reservedAt: r.reserved_at,
      }))
    if (fresh.length === 0) return null

    await pool.query(
      `insert into event_cursors (name, cursor) values ($1, $2)
       on conflict (name) do update set cursor = excluded.cursor, updated_at = now()`,
      [CURSOR_NAME, fresh[fresh.length - 1].reservedAt],
    )
    return unconfirmedActionsAlert(fresh, rows.length)
  } catch (e: any) {
    return {
      severity: 'critical',
      title: 'Unconfirmed payout watch failed',
      message: `Could not read the idempotency ledger: ${e?.message ?? 'unknown'}. A payout whose outcome is unknown would go unreported.`,
    }
  }
}
