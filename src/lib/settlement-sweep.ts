import { Keypair } from '@stellar/stellar-sdk'
import { settleableUnderlyings, type UnderlyingSymbol } from '@/lib/assets'
import {
  scanForSettlement,
  runSettlement,
  DEFAULT_SCAN_LIMIT,
  DEFAULT_SETTLE_LIMIT,
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
  /** Set when the sweep could only scan — no signing key configured. */
  note?: string
}

export async function sweepOnce(opts: {
  dryRun?: boolean
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
      const scan = await scanForSettlement({
        from: opts.from ?? 0,
        limit: opts.scanLimit ?? DEFAULT_SCAN_LIMIT,
        asset,
      })
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
