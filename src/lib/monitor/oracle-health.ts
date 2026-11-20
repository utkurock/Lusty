import {
  REFLECTOR_MAX_STALENESS_SECS,
  REFLECTOR_RESOLUTION_SECS,
  reflectorLastPriceRecord,
  reflectorPriceAt,
  type ReflectorPrice,
} from '@/lib/reflector'
import { upcomingExpiryDates } from '@/lib/expiries'
import { ORACLE_HISTORY_SECS } from '@/lib/oracle-window'
import type { UnderlyingAsset } from '@/lib/assets'
import { fetchCloses } from './klines'
import type { Alert } from './notify'

/**
 * The feed's own health, watched separately from what is settled against it.
 *
 * Every other check here reads the vault. None of them reads the thing the
 * vault prices off: the settlement backlog notices a position that failed to
 * settle, and by then the oracle has been unwell for however long it took the
 * expiry to arrive. The three ways a feed goes wrong, each with its own
 * question:
 *
 *   • It stops publishing. Caught by the last record's age, in multiples of the
 *     feed's own resolution rather than a wall-clock number — a feed on a
 *     five-minute grid and one on an hourly grid are not stale at the same age.
 *   • It has a hole. A period record missing at an expiry inside the oracle's
 *     history window is a settlement that cannot happen at the price it is
 *     supposed to happen at, and the window closes. This is the one that costs
 *     collateral, so it is the one that pages.
 *   • It is published but wrong. Nothing about a fresh, present record says it
 *     is the market's price, and the vault pays real money against it. So it is
 *     compared with the exchange, and a gap beyond the configured band is
 *     reported whatever the feed's own timestamps say.
 *
 * Split into a pure rule and a reader so the rule can be tested at every
 * boundary without a network.
 */

// A record older than this many resolutions is stale. Two, because one is the
// ordinary gap between publications and would alert on every healthy feed.
const STALE_RESOLUTIONS = Number(process.env.MONITOR_ORACLE_STALE_RESOLUTIONS ?? 2)
// How far the oracle may sit from the exchange before it is reported, in basis
// points. Warning at the band, critical at twice it.
const BAND_BPS = Number(process.env.MONITOR_ORACLE_BAND_BPS ?? 200)

export interface OracleReading {
  /** `lastprice`, with no staleness judgement applied. */
  last: ReflectorPrice | null
  /** The feed's period length, in seconds. */
  resolutionSecs: number
  /** Expiries probed for a period record, and those that had none. */
  probed: Date[]
  missing: Date[]
  /** The exchange's price for the same asset, or null when it could not be had. */
  exchange: number | null
}

/**
 * Expiries whose settlement price the oracle should already hold: the book's
 * grid points that have passed and are still inside the oracle's history
 * window. A future expiry has no record yet and is not a hole; one past the
 * window is the backlog check's business, not the feed's.
 */
export function expiriesAtRisk(
  asset: UnderlyingAsset,
  now: number = Date.now(),
  windowSecs: number = ORACLE_HISTORY_SECS,
): Date[] {
  const front = upcomingExpiryDates(new Date(now), asset.expiry)[0]
  if (!front) return []
  const step = asset.expiry.tenorDays * 24 * 60 * 60 * 1000
  const floor = now - windowSecs * 1000
  const out: Date[] = []
  for (let t = front.getTime() - step; t > floor; t -= step) {
    if (t <= now) out.push(new Date(t))
  }
  return out.reverse()
}

/** Basis points between two prices, relative to the exchange's. */
const gapBps = (oracle: number, exchange: number) =>
  exchange > 0 ? (Math.abs(oracle - exchange) / exchange) * 10_000 : 0

/**
 * The alert for one feed's reading, or null when it is healthy. Pure.
 */
export function oracleHealthAlert(
  asset: UnderlyingAsset,
  r: OracleReading,
  now: number = Date.now(),
): Alert | null {
  const unit = asset.symbol
  const feed = asset.feedSymbol
  const ageSecs = r.last ? Math.floor(now / 1000) - r.last.timestamp : null
  const bps = r.last && r.exchange !== null ? gapBps(r.last.price, r.exchange) : null
  const fields: Alert['fields'] = [
    { label: 'underlying', value: unit },
    { label: 'feed', value: feed },
    { label: 'last_price', value: r.last ? String(r.last.price) : '—' },
    { label: 'last_age_secs', value: ageSecs === null ? '—' : String(ageSecs) },
    { label: 'resolution_secs', value: String(r.resolutionSecs) },
    { label: 'expiries_probed', value: String(r.probed.length) },
    { label: 'exchange_price', value: r.exchange === null ? '—' : String(r.exchange) },
    { label: 'gap_bps', value: bps === null ? '—' : bps.toFixed(1) },
  ]

  // A hole at an expiry first: the window on it closes, and nothing else here
  // gets worse by being reported a run later.
  if (r.missing.length > 0) {
    const dates = r.missing.map((d) => d.toISOString()).join(', ')
    return {
      severity: 'critical',
      title: `${unit}: oracle has no price for an expiry that has passed`,
      message:
        `The ${feed} feed has no period record for ${r.missing.length} expiry(ies) still inside ` +
        `its history window: ${dates}. A position on one of those cannot settle at its expiry's ` +
        `price, and once the window closes it settles only through the thirty-day release. ` +
        `Record the price now (record_price) while the feed still has it.`,
      fields,
    }
  }

  if (!r.last) {
    return {
      severity: 'critical',
      title: `${unit}: oracle has no price at all`,
      message:
        `The ${feed} feed returned no last record. Quoting fails closed and nothing can be ` +
        `settled at a new price until it returns.`,
      fields,
    }
  }

  // Past the contract's own bound the live-price fallback is refused too, so
  // this is not merely late.
  if (ageSecs !== null && ageSecs > REFLECTOR_MAX_STALENESS_SECS) {
    return {
      severity: 'critical',
      title: `${unit}: oracle has stopped publishing`,
      message:
        `The ${feed} feed's last record is ${ageSecs}s old, past the ${REFLECTOR_MAX_STALENESS_SECS}s ` +
        `the contract will accept. Settlement at an expiry arriving now has no price to use.`,
      fields,
    }
  }

  const staleAfter = r.resolutionSecs * STALE_RESOLUTIONS
  if (ageSecs !== null && ageSecs > staleAfter) {
    return {
      severity: 'warning',
      title: `${unit}: oracle is behind its own schedule`,
      message:
        `The ${feed} feed's last record is ${ageSecs}s old, more than ${STALE_RESOLUTIONS} ` +
        `resolutions (${staleAfter}s). Nothing has failed yet; a feed that keeps falling behind ` +
        `will miss an expiry.`,
      fields,
    }
  }

  if (bps !== null && bps >= BAND_BPS) {
    const far = bps >= BAND_BPS * 2
    return {
      severity: far ? 'critical' : 'warning',
      title: `${unit}: oracle disagrees with the exchange`,
      message:
        `The ${feed} feed reads ${r.last.price} against the exchange's ${r.exchange} — ` +
        `${bps.toFixed(1)} bps apart, against a ${BAND_BPS} bps band. Positions settle at the ` +
        `feed's number, so this is what the vault would pay` +
        (far ? ', and it is beyond twice the band.' : '.'),
      fields,
    }
  }

  return null
}

/** Read one feed and judge it. Never throws; a failed read is itself an alert. */
export async function checkOracleHealth(asset: UnderlyingAsset): Promise<Alert | null> {
  const unit = asset.symbol
  try {
    const now = Date.now()
    const probed = expiriesAtRisk(asset, now)
    const [last, records, exchange] = await Promise.all([
      reflectorLastPriceRecord(asset),
      Promise.all(probed.map((d) => reflectorPriceAt(d.getTime(), asset))),
      // The exchange is a second opinion, not a dependency: without it the
      // staleness and the hole are still judged.
      fetchCloses('1m', 1, asset)
        .then((c) => c[c.length - 1] ?? null)
        .catch(() => null),
    ])
    return oracleHealthAlert(
      asset,
      {
        last,
        resolutionSecs: REFLECTOR_RESOLUTION_SECS,
        probed,
        missing: probed.filter((_, i) => records[i] === null),
        exchange,
      },
      now,
    )
  } catch (e: any) {
    return {
      severity: 'critical',
      title: `${unit}: oracle health check blind`,
      message: `Could not read the ${asset.feedSymbol} feed: ${e?.message ?? 'unknown'}. Whether it is publishing is unknown.`,
    }
  }
}
