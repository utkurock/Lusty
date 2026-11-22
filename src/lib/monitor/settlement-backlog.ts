import type { UnderlyingAsset } from '@/lib/assets'
import { scanForSettlement, positionKey, bookLabel, type SettlementCandidate } from '@/lib/settlement'
import { getRecordedPrice } from '@/lib/vault-contract'
import { UNPRICED_RELEASE_SECS } from '@/lib/oracle-window'
import type { Alert } from './notify'

/**
 * Is anything expired and still open?
 *
 * Settlement is priced at the oracle's reading for the expiry, and Reflector
 * keeps about a day of it. What happens to a position the sweep did not reach
 * inside that day depends on the instance:
 *
 *   • its expiry's price is recorded on chain (v5+, by any settle or
 *     `record_price` inside the window) — it settles at that price whenever
 *     the sweep gets to it. Late, not lost.
 *   • no price is recorded (v5+) — settle is refused until thirty days after
 *     expiry and then hands the collateral back to its owner as kept, whatever
 *     the price was. An in-the-money position loses its assignment.
 *   • a v4 instance — no recorded price and no release; the collateral stays
 *     escrowed for good.
 *
 * Before v5 only the last existed, and this alarm said so about everything.
 * It now names which of the three each position is in, because they ask for
 * different things: the first a working sweep, the second a decision before
 * the release date, the third a decision with no date at all.
 */

type PriceStatus = 'recorded' | 'unrecorded' | 'unsupported' | 'unknown'

/** One book's expired, unsettled positions and what the chain holds for their expiries. */
export interface Backlog {
  asset: UnderlyingAsset
  candidates: SettlementCandidate[]
  /** By expiry, in ms. A read that failed is 'unknown'. */
  prices: Map<number, PriceStatus>
}

const ids = (asset: UnderlyingAsset, cs: SettlementCandidate[]) =>
  cs.map((c) => positionKey(asset.symbol, c.id, asset.contracts.vault)).join(', ')

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** The alert a backlog calls for. Pure. */
export function backlogAlert(b: Backlog, now: Date = new Date()): Alert | null {
  const { asset, candidates, prices } = b
  if (candidates.length === 0) return null
  const unit = bookLabel(asset.symbol, asset.contracts.vault)
  const status = (c: SettlementCandidate): PriceStatus => prices.get(c.expiry.getTime()) ?? 'unknown'

  const past = candidates.filter((c) => c.pastDeadline)
  const pending = candidates.filter((c) => !c.pastDeadline)
  const late = past.filter((c) => status(c) === 'recorded')
  const unpriced = past.filter((c) => status(c) === 'unrecorded')
  const locked = past.filter((c) => status(c) === 'unsupported')
  const unread = past.filter((c) => status(c) === 'unknown')

  const fields = [
    { label: 'underlying', value: unit },
    { label: 'due', value: String(pending.length) },
    { label: 'past_window_recorded', value: String(late.length) },
    { label: 'past_window_unpriced', value: String(unpriced.length) },
    { label: 'past_window_v4', value: String(locked.length) },
    { label: 'past_window_unread', value: String(unread.length) },
  ]

  if (unpriced.length + locked.length + unread.length > 0) {
    const parts: string[] = []
    if (unpriced.length > 0) {
      const release = Math.min(...unpriced.map((c) => c.expiry.getTime())) + UNPRICED_RELEASE_SECS * 1000
      parts.push(
        `${unpriced.length} position(s) have no recorded price: the contract refuses to settle them ` +
          `until thirty days after expiry (the first on ${day(release)}) and then releases their ` +
          `collateral to the owner as kept, assigned or not — ${ids(asset, unpriced)}.`,
      )
      fields.push({ label: 'first_release', value: day(release) })
    }
    if (locked.length > 0) {
      parts.push(
        `${locked.length} position(s) are on a v4 instance, which has no recorded price and no ` +
          `release: their collateral stays escrowed for good — ${ids(asset, locked)}.`,
      )
    }
    if (unread.length > 0) {
      parts.push(
        `${unread.length} position(s) are past the window and whether their price is recorded ` +
          `could not be read — ${ids(asset, unread)}.`,
      )
    }
    if (late.length > 0) {
      parts.push(`${late.length} more are past the window but settle at their recorded price.`)
    }
    return {
      severity: 'critical',
      title: `${unit}: settlement missed the oracle window`,
      message: `${past.length} expired ${unit} position(s) are past the oracle's history window. ${parts.join(' ')}`,
      fields,
    }
  }

  const parts = [`${candidates.length} ${unit} position(s) have expired and are not settled.`]
  if (late.length > 0) {
    parts.push(`${late.length} are past the oracle window and settle at their recorded price.`)
  }
  // Inside the window a recorded price means the deadline no longer matters.
  const racing = pending.filter((c) => status(c) !== 'recorded')
  if (racing.length > 0) {
    const soonest = Math.min(...racing.map((c) => c.settleBy.getTime()))
    const hoursLeft = Math.max(0, (soonest - now.getTime()) / 3_600_000)
    parts.push(
      `The earliest leaves the oracle's history in ${hoursLeft.toFixed(1)}h; after that it settles ` +
        `only at a recorded price, or is released unassigned thirty days after expiry.`,
    )
    fields.push({ label: 'hours_to_deadline', value: hoursLeft.toFixed(1) })
  }
  return {
    severity: 'warning',
    title: `${unit}: settlement sweep is behind`,
    message: parts.join(' '),
    fields,
  }
}

/** Reads the book's backlog off the chain and describes it. */
export async function checkSettlementBacklog(asset: UnderlyingAsset): Promise<Alert | null> {
  const unit = bookLabel(asset.symbol, asset.contracts.vault)
  try {
    const scan = await scanForSettlement({ asset })
    if (scan.candidates.length === 0) return null
    const prices = new Map<number, PriceStatus>()
    // One read per expiry, not per position: the price belongs to the expiry.
    for (const t of new Set(scan.candidates.map((c) => c.expiry.getTime()))) {
      prices.set(t, await getRecordedPrice(new Date(t), asset).catch(() => 'unknown' as const))
    }
    return backlogAlert({ asset, candidates: scan.candidates, prices })
  } catch (e: any) {
    return {
      severity: 'critical',
      title: `${unit}: settlement scan failed`,
      message: `Could not read the ${unit} vault's positions: ${e?.message ?? 'unknown'}. Whether anything is due to settle is unknown.`,
    }
  }
}
