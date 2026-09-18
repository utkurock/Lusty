// Multi-expiry scheduler.
// Lusty splits each "epoch month" into multiple Friday expiries so users can
// pick the duration that matches their view. APR is derived from the selected
// expiry's days-to-expiry and its own pool utilization.
//
// M2-04: the schedule is the asset's, not the module's. How many expiries a
// book keeps open, how close to settlement it still writes and how far apart
// its expiries sit are declared per asset (`ExpiryParams`, since M2-01) and
// read here. They are not cosmetic: `openExpiries` is the divisor that turns a
// monthly capacity into the per-expiry bucket reconciled against the contract
// (M2-05), so a book quoting off another book's count would quote against a
// cap its own instance does not enforce.
//
// Every function below takes the parameters and defaults to XLM's, which is
// the same absent-means-XLM rule the rest of the app has followed since M1-06.

import { XLM, type ExpiryParams } from './assets'

export interface ExpiryOption {
  id: string
  label: string            // e.g. "Apr_24"
  date: Date               // Friday 08:00 UTC
  daysToExpiry: number     // ceil(days until expiry)
  totalEpochDays: number   // nominal length of this expiry's window (used for time-decay)
  utilization: number      // 0..1 — how full this expiry's pool currently is (mock)
  totalDeposited: number
  vaultCap: number
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// No deposits accepted with fewer days than an asset's `minDaysToExpiry` until
// its expiry. Prevents the last-day rush where users grab a high-decay premium
// hours before settlement and the vault carries assignment risk it cannot
// price properly. How many days that is belongs to the book: a slower
// underlying can be written closer to settlement than a fast one.
export function minDaysToExpiry(params: ExpiryParams = XLM.expiry): number {
  return params.minDaysToExpiry
}

/** Rolling expiries a book keeps open at once, and its capacity divisor. */
export function openExpiryCount(params: ExpiryParams = XLM.expiry): number {
  return params.openExpiries
}

// How aggregate vault utilization is spread across the rolling expiries: the
// front expiry carries 100% of it, mid 60%, back 30%. Reflects real-world flow
// concentration and means the front-week APR drops first as the vault fills.
// Shared by the UI quote AND the deposit API so the displayed and paid premium
// agree (see expiryUtilization / dynamicAprFactor).
export const REAL_DISTRIBUTION = [1.0, 0.6, 0.3]

// Per-expiry utilization (0..0.98) for the dynamic-APR engine, derived from the
// aggregate sold/cap ratio and the expiry's slot in the rolling schedule.
export function expiryUtilization(aggregateUtil: number, index: number): number {
  const realU = Math.min(0.98, Math.max(0, aggregateUtil))
  const dist =
    REAL_DISTRIBUTION[index] ?? REAL_DISTRIBUTION[REAL_DISTRIBUTION.length - 1]
  return Math.max(0, Math.min(0.98, realU * dist))
}

export function expiryLabel(date: Date): string {
  return `${MONTH_ABBR[date.getUTCMonth()]}_${String(date.getUTCDate()).padStart(2, '0')}`
}

// The book's expiries at 08:00 UTC (UTC so client and server agree on the
// canonical timestamp, which is what lets capacity buckets match deposits).
//
// The first one is the next Friday at or after the book's minimum tenor, and
// each one after it sits `tenorDays` later. A tenor that is a multiple of
// seven keeps the whole schedule on Fridays, which is what both books declare;
// one that is not steps off the weekday grid deliberately rather than snapping
// back to it, because a schedule that silently rounds is a schedule nobody can
// reconcile against a settlement.
function scheduleFrom(from: Date, params: ExpiryParams): Date[] {
  const cutoff = new Date(from.getTime() + params.minDaysToExpiry * 24 * 60 * 60 * 1000)
  const dow = cutoff.getUTCDay()
  const daysUntilFriday = (5 - dow + 7) % 7
  const first = new Date(cutoff)
  first.setUTCDate(first.getUTCDate() + daysUntilFriday)
  first.setUTCHours(8, 0, 0, 0)

  // Pinning the hour can walk the anchor back behind the cutoff: a cutoff that
  // lands on a Friday afternoon snaps to 08:00 that same morning, which is
  // inside the minimum tenor the book just declared. With one open expiry and
  // a two-day minimum that is every Wednesday afternoon UTC — the screen offers
  // a front expiry and `/api/vault/authorize` then refuses it with a 409,
  // because that route reads the same minimum and reads it correctly. Step a
  // whole tenor forward rather than shaving hours off the bound.
  if (first.getTime() < cutoff.getTime()) {
    first.setUTCDate(first.getUTCDate() + params.tenorDays)
  }

  const out: Date[] = []
  for (let i = 0; i < params.openExpiries; i++) {
    const d = new Date(first)
    d.setUTCDate(d.getUTCDate() + i * params.tenorDays)
    out.push(d)
  }
  return out
}

// Open expiry dates for one book. Shared by the UI and the server's capacity
// buckets so both agree on which expiries exist.
export function upcomingExpiryDates(
  from: Date = new Date(),
  params: ExpiryParams = XLM.expiry,
): Date[] {
  return scheduleFrom(from, params)
}

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.ceil((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24)))
}

/**
 * Days-to-expiry of the FARTHEST currently-open expiry. The pricing engine uses
 * this as the time-scaling reference so the longest open expiry quotes at the
 * APR ceiling and nearer expiries scale below it — robust to the rolling
 * schedule (the reference moves with the expiries instead of being a fixed
 * constant that the longest expiry may never reach).
 */
export function maxOpenExpiryDays(
  from: Date = new Date(),
  params: ExpiryParams = XLM.expiry,
): number {
  const dates = upcomingExpiryDates(from, params)
  const last = dates[dates.length - 1]
  return Math.max(params.minDaysToExpiry, daysBetween(from, last))
}

interface RealVaultStats {
  totalDeposited: number  // USD-equivalent already sold to the vault
  vaultCap: number        // USD-equivalent total capacity
}

/**
 * Returns 3 rolling Friday expiries: ~1w, ~2w, ~3w ahead.
 *
 * If `realStats` is provided we use the live on-chain utilization for the
 * nearest expiry and taper it out for farther expiries (since most flow
 * clusters around the front-month). This makes the dynamic APR engine
 * react to real deposits instead of mock data.
 *
 * If `realStats` is omitted we fall back to a deterministic mock — useful
 * for SSR / first paint before /api/vault/stats has resolved.
 */
export function getExpiryOptions(
  type: 'call' | 'put' = 'call',
  realStats?: RealVaultStats,
  params: ExpiryParams = XLM.expiry,
): ExpiryOption[] {
  const now = new Date()
  const fridays = upcomingExpiryDates(now, params)

  // Deterministic-ish utilization per day so UI doesn't jitter every second
  // when we don't have real data yet.
  const daySeed = Math.floor(now.getTime() / (1000 * 60 * 60 * 24))
  const rand = (n: number) => {
    const x = Math.sin(daySeed * 37 + n * 13 + (type === 'put' ? 7 : 0)) * 10000
    return x - Math.floor(x)
  }

  // Distribute the live utilization across expiries: front month carries
  // ~100% of it, mid ~60%, back ~30%. Reflects real-world flow concentration
  // and means the front-week APR drops first when the vault fills.
  const realURaw = realStats
    ? realStats.totalDeposited / Math.max(realStats.vaultCap, 1)
    : null

  return fridays.map((date, i) => {
    const daysToExpiry = Math.max(params.minDaysToExpiry, daysBetween(now, date))
    const totalEpochDays = params.tenorDays * (i + 1)

    // Cap & utilization: prefer real on-chain data when available.
    const vaultCap = realStats?.vaultCap ?? 5_000_000
    let utilization: number
    if (realURaw !== null) {
      utilization = expiryUtilization(realURaw, i)
    } else {
      const baseUtil = [0.68, 0.42, 0.18][i] ?? 0.3
      const jitter = (rand(i) - 0.5) * 0.12
      utilization = Math.max(0.05, Math.min(0.95, baseUtil + jitter))
    }
    const totalDeposited = Math.round(vaultCap * utilization)

    const label = expiryLabel(date)

    return {
      id: label,
      label,
      date,
      daysToExpiry,
      totalEpochDays,
      utilization,
      totalDeposited,
      vaultCap,
    }
  })
}

/**
 * Dynamic APR adjustment applied on top of the Black-Scholes fair APR.
 *
 *   time factor:  APR tapers in the final days of the epoch. Rysk-style time
 *                 decay so short-dated quotes don't spike unrealistically.
 *   util factor:  Kinked Aave/Compound-style curve. Empty pool boosts APR
 *                 to attract LPs; once utilization crosses the kink the APR
 *                 falls hard so late depositors can't crowd into a saturated
 *                 vault and dilute the realised yield.
 */
// Reference horizon: the APR shown on the UI is anchored to a 14-day weekly
// selling window. Shorter residual windows shrink the quoted APR linearly so
// a 1-day-left position doesn't display an annualized spike that nobody can
// actually harvest. 14-day and longer positions see their full BS APR.
const APR_REFERENCE_DAYS = 14

// Kinked utilization curve parameters.
//
// The factor is capped at 1.0 — we never boost APR above the post-fee fair
// value because the deposit API derives the protocol fee assuming the
// displayed APR already represents 75% of the BS fair (see route.ts).
// Boosting above 1.0 double-counts: it inflates the user payout AND the
// fee paid to FEE_WALLET, causing the vault to leak money on every deposit
// at low utilization.
//
// Curve shape now: empty pool quotes the full fair APR, drifts gently below
// the kink, then drops convexly so the last 20% of capacity quotes barely
// anything. Protocol always keeps ≥25% of fair value.
const UTIL_KINK = 0.80
const UTIL_AT_EMPTY = 1.00
const UTIL_AT_KINK = 0.85
const UTIL_AT_FULL = 0.25

function kinkedUtilFactor(u: number): number {
  const uc = Math.max(0, Math.min(1, u))
  if (uc <= UTIL_KINK) {
    const t = uc / UTIL_KINK
    return UTIL_AT_EMPTY + (UTIL_AT_KINK - UTIL_AT_EMPTY) * t
  }
  const over = (uc - UTIL_KINK) / (1 - UTIL_KINK)
  // Convex drop above the kink so the last 20% of capacity quotes barely
  // anything — discourages whales from front-running the cap.
  return UTIL_AT_KINK + (UTIL_AT_FULL - UTIL_AT_KINK) * Math.pow(over, 1.5)
}

// The multiplier the dynamic-APR engine applies on top of the Black-Scholes
// fair APR: time-decay × kinked-utilization. Always in [0, 1] (never boosts
// above fair value). Pulled out so the server can apply the EXACT same factor
// when it pays the premium, keeping the paid amount equal to the UI quote.
export function dynamicAprFactor(daysToExpiry: number, utilization: number): number {
  const timeFactor = Math.min(1, daysToExpiry / APR_REFERENCE_DAYS)
  const utilFactor = kinkedUtilFactor(utilization)
  return Math.max(0, timeFactor * utilFactor)
}

export function adjustApr(baseApr: number, expiry: ExpiryOption): number {
  return Math.max(0, baseApr * dynamicAprFactor(expiry.daysToExpiry, expiry.utilization))
}
