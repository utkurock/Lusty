import { getPool, ensureSchema } from '@/lib/db'
import { allUnderlyings, type UnderlyingAsset } from '@/lib/assets'
import { scanLimitsChanges, type LimitsChange } from '@/lib/contract-events'
import { resetLimitsCache } from '@/lib/vault-limits'
import type { Alert } from './notify'

/**
 * Watching `set_limits` as it happens, rather than reading the result.
 *
 * The reconciliation in lib/vault-limits compares the declared limits with one
 * reading of the instance every few minutes. That catches a limit that stays
 * changed. It cannot catch one raised and put back between two readings, and
 * that is the shape an abuse of the admin key would take: widen the cap, write
 * the oversized position, restore the cap. Every reading on either side is
 * clean.
 *
 * The contract publishes a `limits` event on every change, so the ledger keeps
 * the record the polling misses. This reads those events forward from a cursor
 * kept in the database, so a deploy resumes where the last run stopped instead
 * of re-reading its lookback window and alerting on it again.
 *
 * Any change is reported, because the admin is a 2-of-3 multisig and a change
 * nobody announced is the thing to know about. One that lands on values other
 * than the declared ones is critical: the books are refused until the
 * declaration and the instance agree again.
 */

const CURSOR_NAME = 'vault-limits'

// One stroop, as in the reconciliation: anything smaller is float noise.
const EPSILON = 1e-7

const FIELDS = [
  ['maxPositionCall', 'call position cap'],
  ['maxPositionPut', 'put position cap'],
  ['maxPremiumBps', 'premium ceiling (bps)'],
] as const

/** Where a change departs from what the book declares, field by field. */
export function departures(change: LimitsChange, asset: UnderlyingAsset): string[] {
  const declared = asset.onchainLimits
  return FIELDS.filter(([f]) => Math.abs(change[f] - declared[f]) > EPSILON).map(
    ([f, what]) => `${what} ${declared[f]} → ${change[f]}`,
  )
}

/**
 * The alert for a batch of changes, or null when there were none. Pure, so the
 * rule is testable without a ledger.
 */
export function limitsChangeAlert(
  changes: LimitsChange[],
  books: UnderlyingAsset[],
): Alert | null {
  if (changes.length === 0) return null

  const byVault = new Map(books.filter((b) => b.contracts.vault).map((b) => [b.contracts.vault!, b]))
  const lines: string[] = []
  const fields: Alert['fields'] = []
  let critical = false

  changes.forEach((c, i) => {
    const book = byVault.get(c.contractId)
    const name = book?.symbol ?? `unknown instance ${c.contractId.slice(0, 8)}…`
    const away = book ? departures(c, book) : ['not a book this deployment declares']
    if (away.length > 0) critical = true
    lines.push(
      `${name} at ledger ${c.ledger}: ${
        away.length > 0 ? away.join(', ') : 'set to the declared values'
      }`,
    )
    fields.push({ label: `change_${i + 1}`, value: `${name} ${c.at} tx ${c.txHash ?? '—'}` })
  })

  return {
    severity: critical ? 'critical' : 'warning',
    title: critical ? 'Vault limits changed away from the declared values' : 'Vault limits were set',
    message:
      `${changes.length} set_limits call(s) since the last run. ${lines.join('. ')}.` +
      (changes.length > 1
        ? ' More than one change in one interval is what a raise-and-revert looks like; read every transaction, not only the last.'
        : ''),
    fields,
  }
}

async function readCursor(): Promise<string | undefined> {
  await ensureSchema()
  const { rows } = await getPool().query(`select cursor from event_cursors where name = $1`, [CURSOR_NAME])
  return rows[0]?.cursor ?? undefined
}

async function writeCursor(cursor: string): Promise<void> {
  await getPool().query(
    `insert into event_cursors (name, cursor) values ($1, $2)
     on conflict (name) do update set cursor = excluded.cursor, updated_at = now()`,
    [CURSOR_NAME, cursor],
  )
}

export async function checkLimitsEvents(): Promise<Alert | null> {
  let cursor: string | undefined
  try {
    cursor = await readCursor()
    const scan = await scanLimitsChanges(cursor)
    const alert = limitsChangeAlert(scan.changes, allUnderlyings())
    // Re-read the instances now rather than at the next refresh: if a limit
    // moved, the books should stop quoting on this run, not five minutes on.
    if (scan.changes.length > 0) resetLimitsCache()
    if (scan.cursor && scan.cursor !== cursor) await writeCursor(scan.cursor)
    return alert
  } catch (e: any) {
    return {
      severity: 'critical',
      title: 'Vault limits watch failed',
      message:
        `Could not read set_limits events: ${e?.message ?? 'unknown'}. ` +
        'Limit changes since the last run are unknown until this recovers. ' +
        (cursor
          ? 'If the cursor has aged out of the RPC retention window, delete it from event_cursors to restart from the lookback.'
          : ''),
    }
  }
}
