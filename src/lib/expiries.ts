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

function fridayAfter(date: Date, weeksAhead: number): Date {
  const d = new Date(date)
  const dow = d.getDay()
  const daysUntilFriday = (5 - dow + 7) % 7 || 7
  d.setDate(d.getDate() + daysUntilFriday + weeksAhead * 7)
  d.setHours(8, 0, 0, 0)
  return d
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
  const weeksAhead = [0, 1, 2]

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
  const realU = realStats
    ? Math.min(0.98, Math.max(0, realStats.totalDeposited / Math.max(realStats.vaultCap, 1)))
    : null
  const realDistribution = [1.0, 0.6, 0.3]

  return weeksAhead.map((w, i) => {
    const date = fridayAfter(now, w)
    const daysToExpiry = Math.max(1, daysBetween(now, date))
    const totalEpochDays = 7 + w * 7

    // Cap & utilization: prefer real on-chain data when available.
    const vaultCap = realStats?.vaultCap ?? 5_000_000
    let utilization: number
    if (realU !== null) {
      utilization = Math.max(0, Math.min(0.98, realU * realDistribution[i]))
    } else {
      const baseUtil = [0.68, 0.42, 0.18][i] ?? 0.3
      const jitter = (rand(i) - 0.5) * 0.12
      utilization = Math.max(0.05, Math.min(0.95, baseUtil + jitter))
    }
    const totalDeposited = Math.round(vaultCap * utilization)

    const label = `${MONTH_ABBR[date.getMonth()]}_${String(date.getDate()).padStart(2, '0')}`

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
 *   util factor:  APR falls as the pool fills (more sellers → cheaper premium)
 *                 and rises when the pool is empty.
 */
// Reference horizon: the APR shown on the UI is anchored to a 14-day weekly
// selling window. Shorter residual windows shrink the quoted APR linearly so
// a 1-day-left position doesn't display an annualized spike that nobody can
// actually harvest. 14-day and longer positions see their full BS APR.
const APR_REFERENCE_DAYS = 14

export function adjustApr(baseApr: number, expiry: ExpiryOption): number {
  const timeFactor = Math.min(1, expiry.daysToExpiry / APR_REFERENCE_DAYS)
  const utilFactor = 1 + (0.5 - expiry.utilization) * 0.6
  return Math.max(0, baseApr * timeFactor * utilFactor)
}
