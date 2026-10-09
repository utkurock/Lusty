import { Keypair } from '@stellar/stellar-sdk'
import { ORACLE_HISTORY_SECS } from './oracle-window'
import {
  settleableUnderlying,
  type UnderlyingAsset,
  type UnderlyingSymbol,
} from './assets'
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
 * How many ids one automatic sweep reads per book, across as many scan pages as
 * that takes. The page above bounds one read; this bounds the run. Reaching it
 * is reported, never silent: the next sweep resumes from the book's low-water
 * mark, which only moves past ids that have settled.
 */
export const DEFAULT_SWEEP_SCAN_LIMIT = 2000

// The settle-by deadline is defined in lib/oracle-window, which the dashboard
// imports too — the runner and the screen must not disagree about which
// positions are still closeable.
export { ORACLE_HISTORY_SECS }

/**
 * Identity of a position, which is the pair and not the id.
 *
 * Ids restart at 0 in every instance, so #3 names one position in XLM's book
 * and a different one in BTC's. Anything that remembers a position — a report,
 * a retry, a "do not warn about this twice" set — has to key on both.
 */
export function positionKey(underlying: UnderlyingSymbol, id: number): string {
  return `${underlying}#${id}`
}

export interface SettlementCandidate {
  id: number
  /** The book this id belongs to. Travels with the candidate so a settlement
   *  cannot be submitted against the instance that happened to be default. */
  underlying: UnderlyingSymbol
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
  /** Which book was walked. Every id below is scoped to it. */
  underlying: UnderlyingSymbol
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
   * The lowest id in this window that is not known to be settled — open, due,
   * past its deadline or unreadable — or null if every id read had settled.
   * Everything below it is settled for good, so a sweep may start there.
   */
  firstOpen: number | null
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
  /**
   * Which book to walk. Required: each instance has its own id range and its
   * own next id, so a scan that fell back to a default would report another
   * book's ids as this one's and hand them to a settler.
   */
  asset: UnderlyingAsset
}): Promise<ScanResult> {
  const cursor = Math.max(0, Math.floor(opts.from ?? 0))
  const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_SCAN_LIMIT))
  const now = opts.now ?? new Date()
  const { asset } = opts

  const { nextId } = await getVaultStats(asset)
  const end = Math.min(nextId, cursor + limit)

  const candidates: SettlementCandidate[] = []
  const unreadable: number[] = []
  const stranded: number[] = []
  let firstOpen: number | null = null

  for (let id = cursor; id < end; id++) {
    try {
      const p = await getPosition(id, asset)
      if (p.settled) continue
      if (firstOpen === null) firstOpen = id
      if (p.expiry.getTime() > now.getTime()) continue
      const settleBy = new Date(p.expiry.getTime() + ORACLE_HISTORY_SECS * 1000)
      const pastDeadline = now.getTime() > settleBy.getTime()
      if (pastDeadline) stranded.push(p.id)
      candidates.push({
        id: p.id,
        underlying: asset.symbol,
        owner: p.owner,
        side: p.side,
        strike: p.strike,
        collateral: p.collateral,
        expiry: p.expiry,
        settleBy,
        pastDeadline,
      })
    } catch (err) {
      console.warn(`settlement: could not read ${positionKey(asset.symbol, id)}`, err)
      unreadable.push(id)
      if (firstOpen === null) firstOpen = id
    }
  }

  const scanned = Math.max(0, end - cursor)
  return {
    underlying: asset.symbol,
    cursor,
    scanned,
    nextId,
    nextCursor: end < nextId ? end : null,
    unexamined: Math.max(0, nextId - end),
    candidates,
    unreadable,
    firstOpen,
    pastDeadline: stranded,
  }
}

export interface SettlementOutcome {
  id: number
  underlying: UnderlyingSymbol
  txHash: string
  outcome: string
}

export interface SettlementFailure {
  id: number
  underlying: UnderlyingSymbol
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
  deferred: { id: number; underlying: UnderlyingSymbol }[]
}

// How many times each position has failed to settle in this process, by
// positionKey. A position whose settlement can never succeed — its owner merged
// the account the payout goes to, or dropped the trustline — fails identically
// every run. Taken in id order, enough of those would fill the per-run cap on
// every sweep and nothing behind them would ever be submitted, until their
// oracle window closed too. Ordering by this count sends each one to the back
// after its first failure, so a run always reaches positions it has not tried.
const failures = new Map<string, number>()

/** Forget every recorded failure. Tests only. */
export function resetSettlementMemory(): void {
  failures.clear()
}

/**
 * The order a run submits in: positions still inside their oracle window
 * before those past it, the ones that have failed least before the ones that
 * keep failing, then the soonest deadline first.
 *
 * Past-deadline positions are still attempted — the window is the feed's
 * property, not this code's — but only with what is left of the cap, never in
 * place of a position that can still be closed.
 */
export function prioritize(
  candidates: SettlementCandidate[],
  failedBefore: (c: SettlementCandidate) => number = (c) =>
    failures.get(positionKey(c.underlying, c.id)) ?? 0,
): SettlementCandidate[] {
  return candidates
    .map((c, i) => ({ c, i, f: failedBefore(c) }))
    .sort(
      (a, b) =>
        Number(a.c.pastDeadline) - Number(b.c.pastDeadline) ||
        a.f - b.f ||
        a.c.settleBy.getTime() - b.c.settleBy.getTime() ||
        a.i - b.i
    )
    .map((x) => x.c)
}

/**
 * Settle each candidate, one transaction at a time, in `prioritize` order.
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
  const ordered = prioritize(candidates)
  const take = ordered.slice(0, cap)
  const deferred = ordered
    .slice(cap)
    .map((c) => ({ id: c.id, underlying: c.underlying }))

  const settled: SettlementOutcome[] = []
  const failed: SettlementFailure[] = []

  for (const c of take) {
    // The instance comes off the candidate, never off the default. An id whose
    // book cannot be resolved is refused: submitting it would settle whatever
    // position happens to hold that id in XLM's vault, against XLM's feed and
    // XLM's price — which is not a degraded settlement, it is somebody else's.
    const asset = settleableUnderlying(c.underlying)
    if (!asset) {
      failed.push({
        id: c.id,
        underlying: c.underlying,
        error: `${c.underlying} has no settleable vault — refusing rather than settling elsewhere`,
        permanent: true,
      })
      continue
    }
    try {
      const { txHash, outcome } = await settlePosition(c.id, signer, asset)
      settled.push({ id: c.id, underlying: c.underlying, txHash, outcome })
      failures.delete(positionKey(c.underlying, c.id))
    } catch (err: any) {
      const key = positionKey(c.underlying, c.id)
      failures.set(key, (failures.get(key) ?? 0) + 1)
      failed.push({
        id: c.id,
        underlying: c.underlying,
        error: err?.message ?? 'unknown',
        permanent: c.pastDeadline,
      })
    }
  }

  return { settled, failed, deferred }
}
