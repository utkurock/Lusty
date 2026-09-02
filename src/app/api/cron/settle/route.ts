import { NextResponse } from 'next/server'
import { intParam } from '@/lib/utils'
import { DEFAULT_SCAN_LIMIT, DEFAULT_SETTLE_LIMIT } from '@/lib/settlement'
import { sweepOnce } from '@/lib/settlement-sweep'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const CRON_SECRET = process.env.CRON_SECRET ?? ''

/**
 * Scheduled settlement sweep. Nothing in this repository schedules it: the
 * deployment does, and the schedule is recorded in the README rather than in a
 * config file this application reads. See the note at the foot of this comment.
 *
 * Auth: requires CRON_SECRET, as `Authorization: Bearer <s>` (what most
 * schedulers send) or `?secret=<s>`. If CRON_SECRET is unset we fail closed (403)
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
 * The consequence worth stating plainly: if this endpoint is compromised, it
 * gains nothing an anonymous account does not already have. Anyone can settle
 * the same positions on the same terms, and no key here can do anything else.
 *
 * What does not follow, and what an earlier version of this comment claimed, is
 * that the sweep never running is equally harmless. Settlement is priced at the
 * oracle's reading for the expiry timestamp and Reflector keeps roughly a day
 * of history; after that the contract can no longer obtain the price, fails
 * closed, and the collateral stays escrowed with nothing able to release it —
 * there is no admin override and no upgrade entrypoint. Permissionless
 * settlement means anyone may close a position in time; it does not mean the
 * closing is optional. See ORACLE_HISTORY_SECS in lib/settlement.ts.
 *
 * `?dryRun=1` runs the scan and returns what it would settle without signing
 * anything. It needs no runner key, which makes it the safe way to check the
 * sweep against a live vault.
 *
 * On scheduling, because it has already been got wrong twice: this route was
 * first written against a `vercel.json` cron entry, and the application is
 * deployed to a self-hosted Coolify instance, which never reads that file. The
 * entry was removed and the schedule was moved to the deployment — where it was
 * then never created, and nine positions stranded while nothing swept.
 *
 * So the sweep no longer depends on this route being called at all: the server
 * runs it on an interval of its own (lib/settlement-scheduler.ts), and both
 * paths share one implementation in lib/settlement-sweep.ts. This endpoint
 * remains for an external timer, and for running a sweep by hand.
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
    const report = await sweepOnce({ dryRun, from, scanLimit, settleLimit })
    return NextResponse.json(report)
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
