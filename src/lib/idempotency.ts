import { getPool, ensureSchema } from './db'

export type ActionType = 'claim' | 'swap'

/**
 * Atomically reserves a (action_type, source_hash) pair so the same source
 * transaction can never be processed twice. Backed by a UNIQUE primary key —
 * a parallel second caller hits a conflict and gets `alreadyProcessed: true`
 * without a race window.
 *
 * If the downstream payout fails, call `releaseAction()` so the user can
 * retry. If the server crashes between reserve and payout, the row stays
 * (fail-closed): the user must reach out for manual review rather than
 * silently double-spending the distributor.
 */
export async function reserveAction(
  actionType: ActionType,
  sourceHash: string
): Promise<{ reserved: boolean; alreadyProcessed: boolean }> {
  if (!sourceHash || typeof sourceHash !== 'string') {
    throw new Error('reserveAction: sourceHash required')
  }
  await ensureSchema()
  const pool = getPool()
  const res = await pool.query(
    `insert into processed_actions (action_type, source_hash)
     values ($1, $2)
     on conflict (action_type, source_hash) do nothing
     returning source_hash`,
    [actionType, sourceHash]
  )
  if (res.rowCount === 0) {
    return { reserved: false, alreadyProcessed: true }
  }
  return { reserved: true, alreadyProcessed: false }
}

/**
 * Release a previously reserved action. Call this from a catch block when the
 * payout fails so the user can submit the same source hash again on retry.
 */
export async function releaseAction(
  actionType: ActionType,
  sourceHash: string
): Promise<void> {
  try {
    const pool = getPool()
    await pool.query(
      `delete from processed_actions where action_type = $1 and source_hash = $2`,
      [actionType, sourceHash]
    )
  } catch (e) {
    console.error('releaseAction failed:', e)
  }
}

/**
 * Mark the payout side of the action — useful for audit (when did we actually
 * pay) and for the future "stuck in reserved, no payout" sweep job.
 */
export async function confirmAction(
  actionType: ActionType,
  sourceHash: string,
  payoutHash: string
): Promise<void> {
  try {
    const pool = getPool()
    await pool.query(
      `update processed_actions
         set payout_hash = $3, confirmed_at = now()
       where action_type = $1 and source_hash = $2`,
      [actionType, sourceHash, payoutHash]
    )
  } catch (e) {
    console.error('confirmAction failed:', e)
  }
}
