import { Keypair } from '@stellar/stellar-sdk'
import {
  getVaultStats,
  getPosition,
  settlePosition,
  type OptionSide,
} from './vault-contract'

// Finding and closing expired positions.
// ======================================
// The contract indexes positions by owner, not by state: there is no "every
// unsettled position" view to ask for, and there deliberately is not one —
// iterating storage on chain is what the contract avoids by making settlement
// permissionless in the first place. So the scan happens here, by walking ids
// from 0 to `nextId` and reading each one.
//
// That walk gets more expensive every time someone opens a position, so it is
// bounded and resumable rather than open-ended. Every run reports where it
// stopped and how much it did not look at; a scan that quietly examined the
// first two hundred ids and reported success would read exactly like a scan
// that found nothing to do.
//
// Nothing here is privileged. `settle` is permissionless, so this module is a
// convenience that keeps positions from sitting expired — not a component the
// vault depends on. See `settlePosition` in vault-contract.ts.

/** How many position ids one run will read. */
export const DEFAULT_SCAN_LIMIT = 200
/** How many settlements one run will submit, whatever the scan turned up. */
export const DEFAULT_SETTLE_LIMIT = 25

export interface SettlementCandidate {
  id: number
  owner: string
  side: OptionSide
  strike: number
  collateral: number
  expiry: Date
}

export interface ScanResult {
  /** First id examined this run. */
  cursor: number
  /** How many ids were read. */
  scanned: number
  /** Highest id the contract has issued; ids run 0..nextId-1. */
  nextId: number
  /** Where the next run should start, or null once the scan reached the end. */
  nextCursor: number | null
  /** Ids past this run's window — not examined, not claimed to be clean. */
  unexamined: number
  candidates: SettlementCandidate[]
  /** Ids whose read failed. Not settled, not assumed settled. */
  unreadable: number[]
}

/**
 * Walk the position range looking for positions that have expired and not yet
 * settled.
 *
 * A read failure on one id is recorded rather than thrown: one unreadable
 * position must not hide every other position behind it, and the next run will
 * try again.
 */
export async function scanForSettlement(opts: {
  from?: number
  limit?: number
  now?: Date
} = {}): Promise<ScanResult> {
  const cursor = Math.max(0, Math.floor(opts.from ?? 0))
  const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_SCAN_LIMIT))
  const now = opts.now ?? new Date()

  const { nextId } = await getVaultStats()
  const end = Math.min(nextId, cursor + limit)

  const candidates: SettlementCandidate[] = []
  const unreadable: number[] = []

  for (let id = cursor; id < end; id++) {
    try {
      const p = await getPosition(id)
      if (p.settled) continue
      if (p.expiry.getTime() > now.getTime()) continue
      candidates.push({
        id: p.id,
        owner: p.owner,
        side: p.side,
        strike: p.strike,
        collateral: p.collateral,
        expiry: p.expiry,
      })
    } catch (err) {
      console.warn(`settlement: could not read position ${id}`, err)
      unreadable.push(id)
    }
  }

  const scanned = Math.max(0, end - cursor)
  return {
    cursor,
    scanned,
    nextId,
    nextCursor: end < nextId ? end : null,
    unexamined: Math.max(0, nextId - end),
    candidates,
    unreadable,
  }
}

export interface SettlementOutcome {
  id: number
  txHash: string
  outcome: string
}

export interface SettlementFailure {
  id: number
  error: string
}

export interface SettlementRun {
  settled: SettlementOutcome[]
  failed: SettlementFailure[]
  /** Candidates left for the next run because the submit cap was reached. */
  deferred: number[]
}

/**
 * Settle each candidate, one transaction at a time.
 *
 * One failure never stops the run. The likeliest cause is a stale oracle feed,
 * which the contract refuses on purpose — that position is simply not settleable
 * this minute, and the next run will find it again because nothing about it has
 * changed. Sequentially rather than in parallel because every transaction comes
 * from the same source account and shares its sequence number.
 */
export async function runSettlement(
  candidates: SettlementCandidate[],
  signer: Keypair,
  maxSettlements = DEFAULT_SETTLE_LIMIT,
): Promise<SettlementRun> {
  const cap = Math.max(0, Math.floor(maxSettlements))
  const take = candidates.slice(0, cap)
  const deferred = candidates.slice(cap).map((c) => c.id)

  const settled: SettlementOutcome[] = []
  const failed: SettlementFailure[] = []

  for (const c of take) {
    try {
      const { txHash, outcome } = await settlePosition(c.id, signer)
      settled.push({ id: c.id, txHash, outcome })
    } catch (err: any) {
      failed.push({ id: c.id, error: err?.message ?? 'unknown' })
    }
  }

  return { settled, failed, deferred }
}
