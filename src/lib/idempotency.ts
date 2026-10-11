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
  // A 'swap' key is a funding transaction's hash, and the swap and the bridge
  // both pay out against it. Any other spelling of that hash — uppercase, or a
  // path that resolves to it — would be a second key for one payment, so only
  // the canonical form is accepted here, whatever the caller already checked.
  // 'deposit' keys are `${symbol}:${positionId}` and are not hashes at all.
  if (actionType === 'swap' && !/^[0-9a-f]{64}$/.test(sourceHash)) {
    throw new Error('reserveAction: swap source hash must be 64 lowercase hex characters')
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
 * Keep a reservation whose payout may or may not have landed, and write down
 * which transaction to look for. `confirmed_at` stays null, so the row reads
 * as reserved-and-unconfirmed: retries are refused, and whoever reviews it has
 * the one hash that decides whether the caller was paid.
 */
export async function holdUnconfirmed(
  actionType: ActionType,
  sourceHash: string,
  payoutHash: string
): Promise<void> {
  try {
    const pool = getPool()
    await pool.query(
      `update processed_actions
         set payout_hash = $3
       where action_type = $1 and source_hash = $2 and confirmed_at is null`,
      [actionType, sourceHash, payoutHash]
    )
  } catch (e) {
    console.error('holdUnconfirmed failed:', e)
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

// The swap's XLM flow ledger.
// ===========================
// LUSD is free from the faucet, and lusd_to_xlm turns it into the
// distributor's XLM at spot — the same XLM that pays every fee the faucet, the
// bridge and the swap itself sign. Where the LUSD came from cannot be told
// apart (it is fungible), so the bound is on net flow instead: an address may
// take out in XLM no more than it has put in through xlm_to_lusd, and all
// addresses together no more than a daily ceiling.
//
// Both have to be decided before the payout is signed, and decided once.
// Reading the swap rows logTransaction writes would not do: those are written
// after the payout returns, so overlapping requests from one address — each
// with its own funding hash — would all pass the same stale read, and a payout
// that ended 'unknown' would never be counted at all. So a pending row is
// inserted here, under an advisory lock per address (and a global one for
// outflow), in the same transaction that checked the room for it. It is
// deleted only when the network refused the payout, settled when it landed,
// and left pending when nobody knows — pending counts against both bounds.

export type SwapFlowDirection = 'xlm_to_lusd' | 'lusd_to_xlm'

export type SwapFlowReservation =
  | { ok: true }
  | { ok: false; code: 'already_processed' }
  | { ok: false; code: 'no_xlm_credit'; credit: number }
  | { ok: false; code: 'xlm_daily_cap'; remaining: number }

/** XLM this address may still take out, and XLM everybody may today. */
async function headroom(
  q: { query: (sql: string, params?: unknown[]) => Promise<any> },
  address: string,
  dailyMaxOut: number
): Promise<{ credit: number; remaining: number }> {
  const credit = await q.query(
    `select coalesce(sum(xlm_in), 0) - coalesce(sum(xlm_out), 0) as c
       from swap_flows where address = $1`,
    [address]
  )
  const day = await q.query(
    `select coalesce(sum(xlm_out), 0) as s
       from swap_flows where created_at > now() - interval '1 day'`
  )
  return {
    credit: Number(credit.rows[0]?.c ?? 0),
    remaining: dailyMaxOut - Number(day.rows[0]?.s ?? 0),
  }
}

/**
 * Read-only: how much XLM a lusd_to_xlm swap from this address could take
 * right now. For the preflight, which must say no before the user pays.
 */
export async function swapFlowHeadroom(
  address: string,
  dailyMaxOut: number
): Promise<{ credit: number; remaining: number }> {
  await ensureSchema()
  return headroom(getPool(), address, dailyMaxOut)
}

/**
 * Reserve this swap's XLM flow, or say which bound refuses it.
 *
 * `xlmIn` is what an xlm_to_lusd funding paid the distributor; `xlmOut` is
 * what a lusd_to_xlm payout will send. The pending row is keyed on the funding
 * hash, so the same funding cannot reserve twice.
 */
export async function reserveSwapFlow(input: {
  fundingHash: string
  address: string
  direction: SwapFlowDirection
  xlmIn: number
  xlmOut: number
  dailyMaxOut: number
}): Promise<SwapFlowReservation> {
  await ensureSchema()
  const client = await getPool().connect()
  try {
    await client.query('begin')
    // Address first, global second, always in that order: two requests never
    // hold one lock each while waiting for the other.
    await client.query(`select pg_advisory_xact_lock(hashtext('swapflow:' || $1))`, [
      input.address,
    ])
    // A funding hash already on the ledger is a replay, and says so — not
    // "no credit", which is what its own earlier payout would otherwise read as.
    const seen = await client.query(`select 1 from swap_flows where funding_hash = $1`, [
      input.fundingHash,
    ])
    if ((seen.rowCount ?? 0) > 0) {
      await client.query('rollback')
      return { ok: false, code: 'already_processed' }
    }
    if (input.direction === 'lusd_to_xlm') {
      await client.query(`select pg_advisory_xact_lock(hashtext('swapflow:global'))`)
      const room = await headroom(client, input.address, input.dailyMaxOut)
      if (input.xlmOut > room.credit) {
        await client.query('rollback')
        return { ok: false, code: 'no_xlm_credit', credit: Math.max(0, room.credit) }
      }
      if (input.xlmOut > room.remaining) {
        await client.query('rollback')
        return { ok: false, code: 'xlm_daily_cap', remaining: Math.max(0, room.remaining) }
      }
    }
    const ins = await client.query(
      `insert into swap_flows (funding_hash, address, direction, xlm_in, xlm_out, status)
       values ($1, $2, $3, $4, $5, 'pending')
       on conflict do nothing
       returning funding_hash`,
      [input.fundingHash, input.address, input.direction, input.xlmIn, input.xlmOut]
    )
    if (ins.rowCount === 0) {
      await client.query('rollback')
      return { ok: false, code: 'already_processed' }
    }
    await client.query('commit')
    return { ok: true }
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** The payout was refused by the network, or never sent: give the room back. */
export async function releaseSwapFlow(fundingHash: string): Promise<void> {
  try {
    await getPool().query(
      `delete from swap_flows where funding_hash = $1 and status = 'pending'`,
      [fundingHash]
    )
  } catch (e) {
    console.error('releaseSwapFlow failed:', e)
  }
}

/** The payout landed. */
export async function settleSwapFlow(fundingHash: string): Promise<void> {
  try {
    await getPool().query(
      `update swap_flows set status = 'settled' where funding_hash = $1`,
      [fundingHash]
    )
  } catch (e) {
    console.error('settleSwapFlow failed:', e)
  }
}
