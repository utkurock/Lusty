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
// Nothing here is privileged. `settle` is permissionless, so anyone can do what
// this module does — but somebody has to, and within a bounded time. See the
// deadline below.

/** How many position ids one run will read. */
export const DEFAULT_SCAN_LIMIT = 200
/** How many settlements one run will submit, whatever the scan turned up. */
export const DEFAULT_SETTLE_LIMIT = 25

/**
 * How long after expiry a position can still be settled.
 *
 * Settlement is priced at the oracle's reading for the expiry timestamp, and
 * the contract fails closed when it cannot get one (`StalePrice`). Reflector
 * keeps a ring buffer of historical prices, not a permanent record: once the
 * expiry period is pruned, `price(asset, expiry)` returns nothing, and the
 * contract's only fallback — the live price — is gated on being within an hour
 * of expiry, deliberately, so that a late settlement cannot pick its own price.
 * Past that point nothing can settle the position — not this runner, not the
 * writer, not a stranger. There is no admin override and no upgrade entrypoint,
 * so the collateral stays escrowed. This has been confirmed against the live
 * testnet feed, not inferred from the documentation.
 *
 * Measured there: the reading 20h back was still served, the one 22h back was
 * gone. The nominal 24h here is the wrong side of that boundary on purpose — a
 * position over the real limit costs a simulation that fails for free, while
 * one wrongly written off would be abandoned while it could still have been
 * closed.
 */
export const ORACLE_HISTORY_SECS = 24 * 60 * 60

export interface SettlementCandidate {
  id: number
  owner: string
  side: OptionSide
  strike: number
  collateral: number
  expiry: Date
  /** Last moment the oracle is expected to still price this expiry. */
  settleBy: Date
  /** Past that moment: the attempt is made anyway, but expect it to fail. */
  pastDeadline: boolean
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
  /**
   * Ids past the oracle's history window. Still attempted — the window is a
   * property of the feed, not of this code, and being wrong about it must not
   * strand a position — but a failure on one of these is the permanent kind
   * and should be read as collateral needing a decision, not as a retry.
   */
  pastDeadline: number[]
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
  const stranded: number[] = []

  for (let id = cursor; id < end; id++) {
    try {
      const p = await getPosition(id)
      if (p.settled) continue
      if (p.expiry.getTime() > now.getTime()) continue
      const settleBy = new Date(p.expiry.getTime() + ORACLE_HISTORY_SECS * 1000)
      const pastDeadline = now.getTime() > settleBy.getTime()
      if (pastDeadline) stranded.push(p.id)
      candidates.push({
        id: p.id,
        owner: p.owner,
        side: p.side,
        strike: p.strike,
        collateral: p.collateral,
        expiry: p.expiry,
        settleBy,
        pastDeadline,
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
    pastDeadline: stranded,
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
  /**
   * The oracle can no longer price this expiry, so no later run will do
   * better. Separated from an ordinary failure because the two ask for
   * opposite responses: wait, or act.
   */
  permanent: boolean
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
 * One failure never stops the run. A stale feed is the likeliest cause and the
 * contract refuses it on purpose; usually that means the position is not
 * settleable this minute and the next run will find it again. Usually — a
 * failure past `settleBy` is the other kind, where the reading the contract
 * needs no longer exists and no later run can succeed. The two are reported
 * apart because only one of them is something to wait out.
 *
 * Sequentially rather than in parallel because every transaction comes from the
 * same source account and shares its sequence number.
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
      failed.push({
        id: c.id,
        error: err?.message ?? 'unknown',
        permanent: c.pastDeadline,
      })
    }
  }

  return { settled, failed, deferred }
}
