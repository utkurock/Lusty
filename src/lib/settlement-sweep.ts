import { Keypair } from '@stellar/stellar-sdk'
import {
  scanForSettlement,
  runSettlement,
  DEFAULT_SCAN_LIMIT,
  DEFAULT_SETTLE_LIMIT,
  type SettlementFailure,
  type SettlementOutcome,
} from '@/lib/settlement'

/**
 * One settlement sweep: scan the position range, settle what is due.
 *
 * Extracted so the HTTP route and the in-process scheduler cannot drift apart.
 * A sweep that behaves differently depending on who asked for it is a sweep
 * nobody can reason about, and reasoning about this one matters — the cost of
 * it not running is collateral that can never be released.
 */

export interface SweepReport {
  ok: true
  dryRun: boolean
  scannedAt: string
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
  settled: SettlementOutcome[]
  failed: SettlementFailure[]
  deferred: number[]
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

  const scan = await scanForSettlement({
    from: opts.from ?? 0,
    limit: opts.scanLimit ?? DEFAULT_SCAN_LIMIT,
  })

  // The scan is the honest part of the report either way: it says what it
  // looked at and what it did not, so a caller can tell "nothing to settle"
  // apart from "did not get that far".
  const report: SweepReport = {
    ok: true,
    dryRun,
    scannedAt: new Date().toISOString(),
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
      deferred: scan.candidates.map((c) => c.id),
      note: 'SETTLE_RUNNER_SECRET not configured — scanned only, nothing submitted',
    }
  }

  const run = await runSettlement(
    scan.candidates,
    Keypair.fromSecret(runnerSecret),
    opts.settleLimit ?? DEFAULT_SETTLE_LIMIT
  )

  return { ...report, ...run }
}
