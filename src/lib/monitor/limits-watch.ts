import { getPool, ensureSchema } from '@/lib/db'
import { allUnderlyings, type UnderlyingAsset } from '@/lib/assets'
import {
  scanLimitsChanges,
  scanWithdrawals,
  type LimitsChange,
  type WithdrawalEvent,
} from '@/lib/contract-events'
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
 *
 * On a v5 instance a raise does not bind at once: it is scheduled, announced
 * as `lim_raise`, and binds a day later. Reported here when it is scheduled,
 * that day is the time to withdraw a raise nobody meant, before any position
 * can be written under it.
 */

const CURSOR_NAME = 'vault-limits'

// One stroop, as in the reconciliation: anything smaller is float noise.
const EPSILON = 1e-7

const FIELDS = [
  ['maxPositionCall', 'call position cap'],
  ['maxPositionPut', 'put position cap'],
  ['maxPremiumBps', 'premium ceiling (bps)'],
  // Published only by v5 instances; a v4 event leaves them unset and they are
  // skipped rather than read as zero.
  ['maxExpiryCall', 'call per-expiry cap'],
  ['maxExpiryPut', 'put per-expiry cap'],
] as const

/** Where a change departs from what the book declares, field by field. */
export function departures(change: LimitsChange, asset: UnderlyingAsset): string[] {
  const declared = asset.onchainLimits
  return FIELDS.flatMap(([f, what]) => {
    const now = change[f]
    if (now === undefined || Math.abs(now - declared[f]) <= EPSILON) return []
    return [`${what} ${declared[f]} → ${now}`]
  })
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
    const what = c.effectiveAt
      ? `raise scheduled, binds at ${c.effectiveAt} unless the limits are set again first`
      : away.length > 0
        ? 'set'
        : 'set to the declared values'
    lines.push(`${name} at ledger ${c.ledger}: ${what}${away.length > 0 ? `: ${away.join(', ')}` : ''}`)
    fields.push({ label: `change_${i + 1}`, value: `${name} ${c.at} tx ${c.txHash ?? '—'}` })
  })

  const scheduled = changes.some((c) => c.effectiveAt)
  return {
    severity: critical ? 'critical' : 'warning',
    title: scheduled
      ? 'Vault limit raise scheduled'
      : critical
        ? 'Vault limits changed away from the declared values'
        : 'Vault limits were set',
    message:
      `${changes.length} set_limits call(s) since the last run. ${lines.join('. ')}.` +
      (changes.length > 1
        ? ' More than one change in one interval is what a raise-and-revert looks like; read every transaction, not only the last.'
        : ''),
    fields,
  }
}

async function readCursor(name = CURSOR_NAME): Promise<string | undefined> {
  await ensureSchema()
  const { rows } = await getPool().query(`select cursor from event_cursors where name = $1`, [name])
  return rows[0]?.cursor ?? undefined
}

async function writeCursor(cursor: string, name = CURSOR_NAME): Promise<void> {
  await getPool().query(
    `insert into event_cursors (name, cursor) values ($1, $2)
     on conflict (name) do update set cursor = excluded.cursor, updated_at = now()`,
    [name, cursor],
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

// Withdrawals of free pool liquidity (v5). The other thing the admin can do
// that moves money, so it is watched the same way: a request is announced a
// day before it can be executed, and that day is the time to cancel one
// nobody meant. Retired instances are watched too, since draining one is the
// reason the call exists.

const WITHDRAWALS_CURSOR = 'vault-withdrawals'

/** The alert for a batch of withdrawal steps, or null when there were none. */
export function withdrawalAlert(
  withdrawals: WithdrawalEvent[],
  books: UnderlyingAsset[],
): Alert | null {
  if (withdrawals.length === 0) return null
  const byVault = new Map(books.filter((b) => b.contracts.vault).map((b) => [b.contracts.vault, b]))
  const lines = withdrawals.map((w) => {
    const name = byVault.get(w.contractId)?.symbol ?? `instance ${w.contractId.slice(0, 8)}…`
    const what =
      w.step === 'requested'
        ? `withdrawal of up to ${w.amount} from the ${w.pool} pool requested, executable from ${w.executableAt}`
        : w.step === 'executed'
          ? `${w.amount} withdrawn from the ${w.pool} pool to the treasury`
          : `withdrawal from the ${w.pool} pool cancelled`
    return `${name} at ledger ${w.ledger}: ${what}`
  })
  const moving = withdrawals.some((w) => w.step !== 'cancelled')
  return {
    severity: moving ? 'critical' : 'warning',
    title: withdrawals.some((w) => w.step === 'requested')
      ? 'Vault pool withdrawal requested'
      : moving
        ? 'Vault pool withdrawal executed'
        : 'Vault pool withdrawal cancelled',
    message:
      `${lines.join('. ')}. Only free liquidity can leave, and only to the treasury; ` +
      'a request nobody announced should be cancelled before it becomes executable.',
    fields: withdrawals.map((w, i) => ({
      label: `withdrawal_${i + 1}`,
      value: `${w.step} ${w.at} tx ${w.txHash ?? '—'}`,
    })),
  }
}

export async function checkWithdrawalEvents(): Promise<Alert | null> {
  let cursor: string | undefined
  try {
    cursor = await readCursor(WITHDRAWALS_CURSOR)
    const scan = await scanWithdrawals(cursor)
    if (scan.cursor && scan.cursor !== cursor) await writeCursor(scan.cursor, WITHDRAWALS_CURSOR)
    return withdrawalAlert(scan.withdrawals, allUnderlyings())
  } catch (e: any) {
    return {
      severity: 'critical',
      title: 'Vault withdrawal watch failed',
      message:
        `Could not read withdrawal events: ${e?.message ?? 'unknown'}. ` +
        'Withdrawals requested since the last run are unknown until this recovers.',
    }
  }
}
