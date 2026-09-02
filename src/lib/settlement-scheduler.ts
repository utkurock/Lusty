import { sweepOnce } from '@/lib/settlement-sweep'

/**
 * The settlement sweep, run by the application itself.
 *
 * This exists because the previous arrangement failed in the one way that
 * cannot be undone. Settlement was left to a timer outside the codebase; the
 * timer was never set up; nine positions expired, the oracle pruned the prices
 * for their expiry periods, and the contract — correctly — refused to settle
 * without them. There is no admin path and no upgrade entrypoint, so 53,777 XLM
 * of collateral is now escrowed permanently. The window between "expired" and
 * "unsettleable" is about a day (ORACLE_HISTORY_SECS), and nothing inside the
 * application was watching it close.
 *
 * So the sweep now runs here, in the server process, on an interval. An
 * external scheduler may still call /api/cron/settle — the two share one
 * implementation and settling twice is harmless — but the vault no longer
 * depends on someone remembering to configure one.
 *
 * Notes on the shape of this:
 *
 *   • Every run is logged, including the empty ones. A sweep whose silence and
 *     whose absence look identical is how this happened the first time.
 *   • Overlapping runs are skipped rather than queued. A slow sweep is not an
 *     emergency; two of them submitting the same settle is noise.
 *   • Failures never stop the loop. The next tick tries again, and for a
 *     position inside the oracle window there are many ticks left.
 *   • Several server instances will each run this. `settle` is permissionless
 *     and idempotent — the second caller is told the position is already
 *     settled and pays a fee for the privilege — so the cost of duplication is
 *     a wasted simulation, and the cost of no one sweeping is permanent.
 */

// Frequent enough that an expiry has many attempts inside the oracle's ~24h
// window, rare enough to be invisible in RPC load.
const INTERVAL_MS = Number(process.env.SETTLE_SWEEP_INTERVAL_MS ?? 15 * 60_000)

// A first run shortly after boot, not immediately: let the process finish
// starting before it starts signing.
const FIRST_RUN_DELAY_MS = 60_000

let started = false
let running = false

// Ids already reported as permanently unsettleable. Those positions are
// retried every sweep on purpose — the oracle window is the feed's property,
// not this code's, and being wrong about it must not strand a position — but
// they must not reprint the same nine lines every quarter hour. A backlog that
// scrolls past is one nobody reads, and this log is the only thing standing
// between a late sweep and permanent loss.
const reportedPermanent = new Set<number>()

function enabled(): boolean {
  const flag = process.env.SETTLE_SWEEP_ENABLED
  if (flag != null) return flag === '1' || flag.toLowerCase() === 'true'
  // On by default where it matters. In development it is opt-in, so a local
  // server does not quietly submit transactions against the live vault.
  return process.env.NODE_ENV === 'production'
}

async function tick() {
  if (running) {
    console.warn('settlement sweep: previous run still in flight, skipping tick')
    return
  }
  running = true
  try {
    const r = await sweepOnce()
    const parts = [
      `scanned ${r.scan.scanned}/${r.scan.nextId}`,
      `due ${r.due.length}`,
      `settled ${r.settled.length}`,
      `failed ${r.failed.length}`,
    ]
    if (r.note) parts.push(r.note)
    console.log(`settlement sweep: ${parts.join(' · ')}`)

    // Loud, and separately: past the oracle deadline no later sweep can help,
    // so this is collateral awaiting a decision rather than a retry. Said once
    // per id, at the moment it becomes true.
    const fresh = r.pastDeadline.filter((id) => !reportedPermanent.has(id))
    if (fresh.length > 0) {
      console.error(
        `settlement sweep: ${fresh.length} position(s) past the oracle deadline and no longer settleable: ${fresh.join(', ')}`
      )
    }

    for (const f of r.failed) {
      if (f.permanent) {
        if (reportedPermanent.has(f.id)) continue
        reportedPermanent.add(f.id)
        console.error(`settlement sweep: #${f.id} is permanently unsettleable: ${f.error}`)
        continue
      }
      // Retryable, so worth repeating: the next tick may well fix it, and
      // silence here would hide a sweep failing the same way every time.
      console.warn(`settlement sweep: #${f.id} failed, will retry: ${f.error}`)
    }
    for (const id of fresh) reportedPermanent.add(id)
  } catch (err) {
    console.error('settlement sweep: run failed', err)
  } finally {
    running = false
  }
}

/** Idempotent: safe to call from instrumentation on every module evaluation. */
export function startSettlementScheduler() {
  if (started) return
  started = true

  if (!enabled()) {
    console.log(
      'settlement sweep: disabled (set SETTLE_SWEEP_ENABLED=1 to run it here)'
    )
    return
  }
  if (!process.env.SETTLE_RUNNER_SECRET) {
    // Worth a line at boot rather than a surprise a fortnight later: the sweep
    // will scan and report, but it cannot submit anything.
    console.warn(
      'settlement sweep: SETTLE_RUNNER_SECRET is not set — positions will be scanned and reported, but nothing will be settled'
    )
  }

  console.log(
    `settlement sweep: scheduled every ${Math.round(INTERVAL_MS / 60_000)}m`
  )
  setTimeout(() => {
    void tick()
    setInterval(() => void tick(), INTERVAL_MS).unref?.()
  }, FIRST_RUN_DELAY_MS).unref?.()
}
