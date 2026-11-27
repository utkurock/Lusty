// The backup settlement runner's decisions, apart from the network.
//
// The primary sweep runs inside the application, every SETTLE_SWEEP_INTERVAL_MS.
// The backup runs somewhere else entirely — a scheduled GitHub Actions job, on
// its own fee key — so that the application being down, its host being down,
// or its runner key being drained does not leave expired positions unsettled
// until the oracle's history window closes.
//
// It settles only what the primary left: positions expired for longer than a
// grace, so in the normal case the primary settles everything and the backup
// spends nothing. Settling twice is harmless (`settle` is permissionless and
// the second call is refused as AlreadySettled), but racing the primary would
// pay two fees for one settlement.
//
// When a settle fails, the backup records the expiry's oracle price
// (`record_price`, v5+), so that a position stuck for some other reason — a
// missing trustline, a pool short — can still be settled at the right price
// after the oracle has pruned it.
//
// Pure: handed readers and writers, so the tests run it without a network.

/** Expired, unsettled, and past the primary's grace. */
export function isBackupDue(position, nowSecs, graceSecs) {
  return !position.settled && Number(position.expiry) + graceSecs <= nowSecs
}

/** Run `fn` over `items` with at most `limit` in flight, keeping order. */
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * One backup pass over every vault.
 *
 * @param {object} io
 * @param {string[]} io.vaults contract ids to walk
 * @param {(vault: string) => Promise<number>} io.nextId how many positions the vault has issued
 * @param {(vault: string, id: number) => Promise<{ settled: boolean, expiry: bigint | number }>} io.readPosition
 * @param {((vault: string, id: number) => Promise<{ hash: string, outcome: string }>) | null} io.settle null for a dry run
 * @param {(vault: string, expiry: bigint | number) => Promise<'recorded' | 'already' | 'unsupported'>} io.recordPrice
 * @param {number} io.nowSecs
 * @param {number} io.graceSecs
 * @param {number} [io.concurrency]
 */
export async function runBackup(io) {
  const report = { vaults: [], due: [], settled: [], failed: [], pricesRecorded: [], readErrors: [] }
  for (const vault of io.vaults) {
    let count
    try {
      count = await io.nextId(vault)
    } catch (e) {
      report.readErrors.push({ vault, error: e?.message ?? String(e) })
      continue
    }
    const ids = Array.from({ length: count }, (_, i) => i)
    const positions = await mapLimited(ids, io.concurrency ?? 8, async (id) => {
      try {
        return { id, position: await io.readPosition(vault, id) }
      } catch (e) {
        report.readErrors.push({ vault, id, error: e?.message ?? String(e) })
        return { id, position: null }
      }
    })
    const due = positions.filter((p) => p.position && isBackupDue(p.position, io.nowSecs, io.graceSecs))
    report.vaults.push({ vault, positions: count, due: due.length })
    for (const { id, position } of due) {
      report.due.push({ vault, id, expiry: Number(position.expiry) })
      if (!io.settle) continue
      try {
        const r = await io.settle(vault, id)
        report.settled.push({ vault, id, ...r })
      } catch (e) {
        report.failed.push({ vault, id, error: e?.message ?? String(e) })
      }
    }
  }

  // Hold the price for every expiry whose settle failed, once per expiry.
  const expiries = new Map()
  for (const f of report.failed) {
    const d = report.due.find((x) => x.vault === f.vault && x.id === f.id)
    if (d) expiries.set(`${d.vault}#${d.expiry}`, d)
  }
  for (const { vault, expiry } of expiries.values()) {
    try {
      const r = await io.recordPrice(vault, expiry)
      if (r === 'recorded') report.pricesRecorded.push({ vault, expiry })
    } catch (e) {
      report.failed.push({ vault, expiry, error: `record_price: ${e?.message ?? String(e)}` })
    }
  }
  return report
}
