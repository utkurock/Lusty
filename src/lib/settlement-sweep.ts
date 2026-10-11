import { Keypair } from '@stellar/stellar-sdk'
import {
  settleableUnderlyings,
  type UnderlyingAsset,
  type UnderlyingSymbol,
} from '@/lib/assets'
import {
  scanForSettlement,
  runSettlement,
  DEFAULT_SCAN_LIMIT,
  DEFAULT_SETTLE_LIMIT,
  DEFAULT_SWEEP_SCAN_LIMIT,
  type ScanResult,
  type SettlementCandidate,
  type SettlementFailure,
  type SettlementOutcome,
} from '@/lib/settlement'

/**
 * One settlement sweep: walk every underlying that has a vault and settle what
 * is due in each.
 *
 * Extracted so the HTTP route and the in-process scheduler cannot drift apart.
 * A sweep that behaves differently depending on who asked for it is a sweep
 * nobody can reason about, and reasoning about this one matters — the cost of
 * it not running is collateral that can never be released.
 *
 * The books are reported apart because their ids are: there is no shared id
 * space and no shared cursor, and a single "scanned 40/40" across two vaults
 * would say nothing about either.
 */

/** One underlying's half of a sweep. */
export interface BookSweep {
  underlying: UnderlyingSymbol
  scan: {
    cursor: number
    scanned: number
    nextId: number
    nextCursor: number | null
    unexamined: number
    unreadable: number[]
  }
  due: {
    id: number
    side: string
    strike: number
    collateral: number
    expiry: string
    settleBy: string
    pastDeadline: boolean
  }[]
  /**
   * Hoisted out of `due` because it is the one thing here a human has to act
   * on: these will not close by being left alone.
   */
  pastDeadline: number[]
  /** Set when this book could not be scanned at all. */
  error?: string
}

export interface SweepReport {
  ok: true
  dryRun: boolean
  scannedAt: string
  books: BookSweep[]
  /** Across every book; each entry names the one it came from. */
  settled: SettlementOutcome[]
  failed: SettlementFailure[]
  deferred: { id: number; underlying: UnderlyingSymbol }[]
  pricesRecorded: { underlying: UnderlyingSymbol; expiry: string }[]
  /** Set when the sweep could only scan — no signing key configured. */
  note?: string
}

// Per book, the lowest id not known to be settled. Every id below it has
// settled, and settlement is final, so a sweep may start here instead of at 0.
// In-process only: a restart starts again from 0, which is slower and not
// wrong.
const lowWater = new Map<UnderlyingSymbol, number>()

// Per book, where the next sweep picks up. Not the same thing as the floor
// above: a run that spends its budget stops partway, and restarting at the
// floor would reread the same ids every time while anything beyond them —
// expired, due, inside its oracle window — was never reached. One open
// position low in the book was enough to pin every sweep to its first 2000
// ids. So a run resumes where the last one stopped, and only wraps back to the
// floor once it has reached the end.
const resume = new Map<UnderlyingSymbol, number>()

/** Forget every book's low-water mark and resume point. Tests only. */
export function resetSweepMemory(): void {
  lowWater.clear()
  resume.clear()
}

type BookScan = Omit<ScanResult, 'firstOpen'>

/**
 * Walk one book toward `nextId`, a page at a time, up to `budget` ids, starting
 * where the last run stopped (or at the low-water mark when it reached the
 * end). A single page from id 0 — what this used to do — never reads a
 * position past the first page, however many are due behind it.
 */
async function scanBook(
  asset: UnderlyingAsset,
  pageSize: number,
  budget: number,
): Promise<BookScan> {
  const floor = lowWater.get(asset.symbol) ?? 0
  const start = Math.max(floor, resume.get(asset.symbol) ?? floor)
  let cursor: number | null = start
  let scanned = 0
  let firstOpen: number | null = null
  let last: ScanResult | null = null
  const candidates: SettlementCandidate[] = []
  const unreadable: number[] = []
  const pastDeadline: number[] = []

  while (cursor !== null && scanned < budget) {
    const page: ScanResult = await scanForSettlement({
      from: cursor,
      limit: Math.min(pageSize, budget - scanned),
      asset,
    })
    last = page
    scanned += page.scanned
    candidates.push(...page.candidates)
    unreadable.push(...page.unreadable)
    pastDeadline.push(...page.pastDeadline)
    if (firstOpen === null) firstOpen = page.firstOpen
    if (page.scanned === 0) break
    cursor = page.nextCursor
  }

  const nextId = last?.nextId ?? 0
  const nextCursor = last?.nextCursor ?? null
  // Advance only over ids read and found settled. A run that started above the
  // floor did not read the ids below it, so it has nothing to say about them.
  if (start === floor) lowWater.set(asset.symbol, firstOpen ?? nextCursor ?? nextId)
  // Carry on past the budget next time; wrap to the floor once at the end.
  resume.set(asset.symbol, nextCursor ?? lowWater.get(asset.symbol) ?? 0)
  if (nextCursor !== null) {
    console.warn(
      `settlement-sweep: ${asset.symbol} scan stopped at ${nextCursor} of ${nextId} ` +
        `(${nextId - nextCursor} ids unexamined); the next sweep resumes there`,
    )
  }

  return {
    underlying: asset.symbol,
    cursor: start,
    scanned,
    nextId,
    nextCursor,
    unexamined: last?.unexamined ?? 0,
    candidates,
    unreadable,
    pastDeadline,
  }
}

export async function sweepOnce(opts: {
  dryRun?: boolean
  /**
   * Scan one page from this id instead of the whole book. For a sweep run by
   * hand; it leaves the low-water mark alone.
   */
  from?: number
  scanLimit?: number
  settleLimit?: number
  /** Overrides SETTLE_RUNNER_SECRET; omit outside tests. */
  runnerSecret?: string
} = {}): Promise<SweepReport> {
  const dryRun = opts.dryRun ?? false
  const runnerSecret = opts.runnerSecret ?? process.env.SETTLE_RUNNER_SECRET ?? ''

  const books: BookSweep[] = []
  const candidates: SettlementCandidate[] = []

  // Every book with a vault, not just the ones still being written: an asset
  // withdrawn from quoting keeps its open positions, and nothing but this
  // sweep releases their collateral.
  //
  // One book failing to scan must not hide the others. A vault whose RPC is
  // unwell says so in its own row and the rest of the sweep still runs.
  for (const asset of settleableUnderlyings()) {
    try {
      const pageSize = opts.scanLimit ?? DEFAULT_SCAN_LIMIT
      const scan: BookScan =
        opts.from !== undefined
          ? await scanForSettlement({ from: opts.from, limit: pageSize, asset })
          : await scanBook(asset, pageSize, DEFAULT_SWEEP_SCAN_LIMIT)
      candidates.push(...scan.candidates)
      books.push({
        underlying: scan.underlying,
        scan: {
          cursor: scan.cursor,
          scanned: scan.scanned,
          nextId: scan.nextId,
          nextCursor: scan.nextCursor,
          unexamined: scan.unexamined,
          unreadable: scan.unreadable,
        },
        due: scan.candidates.map((c) => ({
          id: c.id,
          side: c.side,
          strike: c.strike,
          collateral: c.collateral,
          expiry: c.expiry.toISOString(),
          settleBy: c.settleBy.toISOString(),
          pastDeadline: c.pastDeadline,
        })),
        pastDeadline: scan.pastDeadline,
      })
    } catch (err: any) {
      books.push({
        underlying: asset.symbol,
        scan: {
          cursor: opts.from ?? 0,
          scanned: 0,
          nextId: 0,
          nextCursor: opts.from ?? 0,
          unexamined: 0,
          unreadable: [],
        },
        due: [],
        pastDeadline: [],
        error: err?.message ?? 'scan failed',
      })
    }
  }

  // The scan is the honest part of the report either way: it says what it
  // looked at and what it did not, so a caller can tell "nothing to settle"
  // apart from "did not get that far".
  const report: SweepReport = {
    ok: true,
    dryRun,
    scannedAt: new Date().toISOString(),
    books,
    settled: [],
    failed: [],
    deferred: [],
    pricesRecorded: [],
  }

  if (dryRun) return report

  if (!runnerSecret) {
    // Not an error: a deployment may want the scan without a signing key. Say
    // so rather than reporting a clean sweep that never happened.
    return {
      ...report,
      deferred: candidates.map((c) => ({ id: c.id, underlying: c.underlying })),
      note: 'SETTLE_RUNNER_SECRET not configured — scanned only, nothing submitted',
    }
  }

  const run = await runSettlement(
    candidates,
    Keypair.fromSecret(runnerSecret),
    opts.settleLimit ?? DEFAULT_SETTLE_LIMIT
  )

  return { ...report, ...run }
}
