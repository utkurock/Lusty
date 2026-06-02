// Multi-expiry scheduler.
// Lusty splits each "epoch month" into multiple Friday expiries so users can
// pick the duration that matches their view. APR is derived from the selected
// expiry's days-to-expiry and its own pool utilization.

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

// No deposits accepted with fewer days than this until the Friday expiry.
// Prevents last-day rush where users grab a high-decay premium hours before
// settlement and the vault carries assignment risk it can't price properly.
export const MIN_DAYS_TO_EXPIRY = 2

// Rolling expiries open at once — mirrors VAULT_EPOCHS_PER_MONTH on the server.
export const ACTIVE_EXPIRY_COUNT = 3

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

// Next `count` Friday 08:00 UTC expiries (UTC so client and server agree on the
// canonical timestamp, which is what lets capacity buckets match deposits).
function nextFridays(from: Date, count: number): Date[] {
  const cutoff = new Date(from.getTime() + MIN_DAYS_TO_EXPIRY * 24 * 60 * 60 * 1000)
  const dow = cutoff.getUTCDay()
  const daysUntilFriday = (5 - dow + 7) % 7
  const first = new Date(cutoff)
  first.setUTCDate(first.getUTCDate() + daysUntilFriday)
  first.setUTCHours(8, 0, 0, 0)

  const out: Date[] = []
  for (let i = 0; i < count; i++) {
    const d = new Date(first)
    d.setUTCDate(d.getUTCDate() + i * 7)
    out.push(d)
  }
  return out
}

// Open expiry dates (canonical UTC Fridays). Shared by the UI and the server's
// capacity buckets so both agree on which expiries exist.
export function upcomingExpiryDates(
  from: Date = new Date(),
  count: number = ACTIVE_EXPIRY_COUNT,
): Date[] {
  return nextFridays(from, count)
}

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.ceil((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24)))
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
): ExpiryOption[] {
  const now = new Date()
  const fridays = upcomingExpiryDates(now, ACTIVE_EXPIRY_COUNT)

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
    const daysToExpiry = Math.max(MIN_DAYS_TO_EXPIRY, daysBetween(now, date))
    const totalEpochDays = 7 + i * 7

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
