import { getPool, ensureSchema } from './db'

export type ActionType = 'deposit' | 'claim' | 'swap'

/**
 * Atomically reserves a (action_type, source_hash) pair so the same source
 * transaction can never be processed twice. Two layers of uniqueness, both
 * enforced in the database (no race window):
 *
 *   1. The (action_type, source_hash) primary key blocks same-endpoint
 *      replay — the same hash claimed twice, swapped twice, deposited twice.
 *   2. A partial unique index on source_hash over the INTAKE types
 *      ('deposit','swap') blocks cross-endpoint reuse — one on-chain payment
 *      to the distributor can fund a deposit OR a swap, never both. 'claim'
 *      is exempt because it legitimately reuses the deposit's hash to settle
 *      that same position.
 *
 * The target-less ON CONFLICT swallows violations of EITHER index, so both
 * cases surface uniformly as `alreadyProcessed: true`.
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
     on conflict do nothing
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
