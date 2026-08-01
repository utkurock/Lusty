import { NextResponse } from 'next/server'
import { Keypair } from '@stellar/stellar-sdk'
import { intParam } from '@/lib/utils'
import {
  scanForSettlement,
  runSettlement,
  DEFAULT_SCAN_LIMIT,
  DEFAULT_SETTLE_LIMIT,
} from '@/lib/settlement'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const CRON_SECRET = process.env.CRON_SECRET ?? ''
const RUNNER_SECRET = process.env.SETTLE_RUNNER_SECRET ?? ''

/**
 * Scheduled settlement sweep. Wired to a Vercel cron in vercel.json.
 *
 * Auth: requires CRON_SECRET, as `Authorization: Bearer <s>` (how Vercel cron
 * sends it) or `?secret=<s>`. If CRON_SECRET is unset we fail closed (403)
 * rather than leave an endpoint anyone can drive. Same pattern as
 * /api/cron/monitor, deliberately — there should be one way to authorize a
 * scheduled job in this codebase.
 *
 * What this route can do, and it is a short list
 * ----------------------------------------------
 * It calls `settle(id)` on positions that have expired. That is the whole
 * surface. `settle` is permissionless — the contract checks no caller identity,
 * pins the settlement price to the oracle reading at the expiry timestamp, and
 * pays the position's owner. So the runner key:
 *
 *   • cannot move collateral. Only `settle` releases escrow, and it releases it
 *     to the owner, never to the caller.
 *   • cannot change a price. The oracle reading at expiry is already fixed by
 *     the time this runs; calling earlier or later cannot alter it.
 *   • cannot change a parameter. `set_limits` is admin-only and this key is not
 *     the admin; nothing on this path can reach it.
 *   • cannot sign a premium. That is the quoter's key, which lives in a
 *     different environment variable and is never loaded here.
 *   • earns nothing. It pays the transaction fee and receives no payout and no
 *     fee share, which was demonstrated on chain in 16367b8: an unrelated
 *     account settled four positions and ended down only its fees.
 *
 * The consequence worth stating plainly: if this endpoint is compromised, or
 * simply never runs, no position is at risk. Anyone can settle the same
 * positions on the same terms. This is a convenience for writers who would
 * rather not send the transaction themselves, not a component the vault's
 * safety depends on.
 *
 * `?dryRun=1` runs the scan and returns what it would settle without signing
 * anything. It needs no runner key, which makes it the safe way to check the
 * sweep against a live vault.
 */
async function handle(req: Request) {
  if (!CRON_SECRET) {
    return NextResponse.json(
      { error: 'settlement runner disabled — CRON_SECRET not configured' },
      { status: 403 }
    )
  }
  const url = new URL(req.url)
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  const qs = url.searchParams.get('secret')
  if (bearer !== CRON_SECRET && qs !== CRON_SECRET) {
    return NextResponse.json({ error: 'not authorized' }, { status: 403 })
  }

  const dryRun = url.searchParams.get('dryRun') === '1'
  const from = intParam(url.searchParams, 'from', 0)
  const scanLimit = intParam(url.searchParams, 'limit', DEFAULT_SCAN_LIMIT)
  const settleLimit = intParam(
    url.searchParams,
    'maxSettlements',
    DEFAULT_SETTLE_LIMIT
  )

  try {
    const scan = await scanForSettlement({ from, limit: scanLimit })

    // The scan is the honest part of the response either way: it says what it
    // looked at and what it did not, so a caller can tell "nothing to settle"
    // apart from "did not get that far".
    const report = {
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
      })),
    }

    if (dryRun) return NextResponse.json(report)

    if (!RUNNER_SECRET) {
      // Not an error: a deployment may want the scan without a signing key.
      // Say so rather than reporting a clean sweep that never happened.
      return NextResponse.json({
        ...report,
        settled: [],
        failed: [],
        deferred: scan.candidates.map((c) => c.id),
        note: 'SETTLE_RUNNER_SECRET not configured — scanned only, nothing submitted',
      })
    }

    const run = await runSettlement(
      scan.candidates,
      Keypair.fromSecret(RUNNER_SECRET),
      settleLimit
    )

    return NextResponse.json({ ...report, ...run })
  } catch (e: any) {
    return NextResponse.json(
      { error: 'settlement sweep failed', detail: e?.message ?? 'unknown' },
      { status: 500 }
    )
  }
}

// Vercel cron issues GET; allow POST too for manual curl.
export const GET = handle
export const POST = handle
