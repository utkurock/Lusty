// Lusty quote engine — THE single source of truth.
// =================================================
// Every premium the vault pays AND every APR the UI shows flows through this
// file. There is no second adjustment layer: what `quoteOption` returns is what
// the user sees and what the distributor pays.
//
// The pipeline, fully explainable end-to-end:
//
//   σ_realized   ← XLM's own price history (vol.ts, EWMA realized vol)
//   σ_offered    = σ_realized·(1+spread_rel) + spread_abs   (vol risk premium)
//   F            ← forward from perp funding (forward.ts), F ≈ S for weeklies
//   P_fair       = Black-76(side, F, K, T, σ_offered)       (per unit notional)
//   c_eff        = haircut_base + utilization_margin(u)     (one haircut, clamped)
//   P_user       = P_fair · (1 − c_eff)                     (paid strictly < fair)
//   capital      = side=='call' ? S : K                     (capital at risk)
//   APR          = P_user / capital · 365/days · 100        (annualized prem yield)
//
// Notes:
//   * No fabricated σ (was a hardcoded 80%) and no fabricated smile.
//   * No arbitrary risk-free rate (was r=0.05); carry lives in the forward.
//   * Put APR denominator is the strike (cash locked), not spot — the old bug.
//   * The utilization response is INSIDE the haircut, not a separate factor
//     applied only to the display (which used to let shown ≠ paid).

import {
  black76Call,
  black76Put,
  calculateAPR,
  roundStrike,
  CALL_STRIKE_MULTIPLIERS,
  PUT_STRIKE_MULTIPLIERS,
  callStrikeLabel,
  putStrikeLabel,
} from './pricing'
import { getRealizedVol } from './vol'
import { getForward } from './forward'
import { maxOpenExpiryDays } from './expiries'

// ────────────────────────────────────────────────────────────────────────────
// Tunables — "Balanced" risk appetite (see env overrides below).
// ────────────────────────────────────────────────────────────────────────────

// Vol risk premium: implied (what we sell at) trades above realized. We add a
// relative + absolute cushion so we are selling vol with an edge, not at cost.
const VOL_SPREAD_REL = num(process.env.VOL_SPREAD_REL, 0.10) // +10% of σ
const VOL_SPREAD_ABS = num(process.env.VOL_SPREAD_ABS, 0.03) // +3 vol points

// Spread retained on every option (the vault carries unhedged inventory risk).
// The utilization response is added on top.
const HAIRCUT_BASE = num(process.env.HAIRCUT_BASE, 0.20)

// Pricing σ ceiling. XLM realized vol can spike past 150% in stressed regimes;
// pricing off a transient spike produces unstable quotes. Cap the σ used for
// pricing for quote stability.
const MAX_PRICING_SIGMA = num(process.env.MAX_PRICING_SIGMA, 1.0) // 100%

// Ceiling on the offered APR (percent). Short-dated tenors annualize by
// ×365/days, which makes raw weekly yields volatile and unstable as a headline
// number. Bound the offered APR for a stable, sustainable quote.
const MAX_APR = num(process.env.MAX_APR, 120) // percent

// Explicit protocol commission, taken as a fraction of the upfront premium the
// user receives (never from their collateral). Guaranteed revenue on every
// deposit, independent of how the option settles. The displayed APR/premium are
// net of this, so what's shown equals what's paid. Set 0 to disable.
const PREMIUM_FEE_RATE = num(process.env.PREMIUM_FEE_RATE, 0.10) // 10% of upfront

// Time-to-expiry reference (days). The offered APR scales with days-to-expiry
// (timeFactor = min(1, days/ref)), so longer commitments quote a higher APR and
// the quote tapers down as expiry approaches. Raw APR ∝ 1/√days and this factor
// ∝ days, so the net offered APR ∝ √days — monotonically rising with tenor.
//
// Default (env 0 / unset) = AUTO: the reference is the farthest open expiry, so
// the longest expiry always quotes at the ceiling and the schedule rolling
// forward never strands it below cap. Set TIME_REF_DAYS>0 to pin a fixed value.
const TIME_REF_DAYS_ENV = num(process.env.TIME_REF_DAYS, 0)
const TIME_REF_FALLBACK = 21 // used only if dynamic lookup is unavailable

function resolveTimeRefDays(): number {
  if (TIME_REF_DAYS_ENV > 0) return TIME_REF_DAYS_ENV
  try {
    const d = maxOpenExpiryDays()
    return d > 0 ? d : TIME_REF_FALLBACK
  } catch {
    return TIME_REF_FALLBACK
  }
}

// Utilization → extra haircut (kinked, Aave/Compound style). Empty pool → 0
// extra (max APR to attract flow); past the kink the haircut ramps hard so the
// last slice of capacity quotes little (discourages crowding a full vault).
const UTIL_KINK = 0.80
const UTIL_MARGIN_AT_KINK = 0.08
const UTIL_MARGIN_AT_FULL = 0.33

// Clamp on the effective haircut so we never gouge nor give the vault away.
const HAIRCUT_MIN = 0.08
const HAIRCUT_MAX = 0.50

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return isFinite(n) && n >= 0 ? n : fallback
}

/** Kinked utilization → extra haircut. u ∈ [0,1]. */
export function utilizationMargin(u: number): number {
  const uc = Math.max(0, Math.min(1, u))
  if (uc <= UTIL_KINK) {
    return UTIL_MARGIN_AT_KINK * (uc / UTIL_KINK)
  }
  const over = (uc - UTIL_KINK) / (1 - UTIL_KINK)
  return UTIL_MARGIN_AT_KINK + (UTIL_MARGIN_AT_FULL - UTIL_MARGIN_AT_KINK) * Math.pow(over, 1.5)
}

export function offeredVol(sigmaRealized: number): number {
  const raw = sigmaRealized * (1 + VOL_SPREAD_REL) + VOL_SPREAD_ABS
  return Math.min(raw, MAX_PRICING_SIGMA)
}

// ────────────────────────────────────────────────────────────────────────────
// Core quote
// ────────────────────────────────────────────────────────────────────────────

export interface QuoteInput {
  side: 'call' | 'put'
  spot: number
  /** Forward at expiry; defaults to spot if omitted. */
  forward?: number
  strike: number
  daysToExpiry: number
  /** Annualized realized vol (decimal). Required — no fabricated default. */
  sigmaRealized: number
  /** Pool utilization 0..1 for this strike/expiry. Default 0 (empty → max APR). */
  utilization?: number
  /** Time-scaling reference (days). Defaults to the farthest open expiry. */
  timeRefDays?: number
}

export interface Quote {
  side: 'call' | 'put'
  spot: number
  forward: number
  strike: number
  daysToExpiry: number
  /** Realized σ from XLM history (decimal). */
  sigmaRealized: number
  /** σ actually used to price = realized + vol risk premium (decimal). */
  sigmaOffered: number
  /** Black-76 fair premium per unit notional (USD). */
  fairPremium: number
  /** Effective haircut applied (decimal, 0..1). */
  haircut: number
  /** What the user receives per unit notional (USD). */
  userPremium: number
  /** Protocol edge per unit notional (USD) = fairPremium − userPremium. */
  protocolEdge: number
  /** Capital at risk per unit (USD): spot for calls, strike for puts. */
  capital: number
  /** Utilization used in the haircut (0..1). */
  utilization: number
  /** Annualized premium yield offered to the user (percent), net of the fee. */
  apr: number
  /** True if the APR hit the MAX_APR ceiling (premium pinned below fair). */
  aprCapped: boolean
  /** Explicit protocol commission per unit notional (USD), taken from upfront. */
  protocolFee: number
}

// Raw (un-normalized) Black-76 → haircut → annualized APR for a single strike.
// The ladder normalization in quoteOption() scales these so the nearest strike
// hits the time-scaled target and the gradient across strikes is preserved.
function rawStrike(
  side: 'call' | 'put',
  forward: number,
  spot: number,
  strike: number,
  timeYears: number,
  daysToExpiry: number,
  sigmaOffered: number,
  baseHaircut: number,
): { fair: number; capital: number; apr: number } {
  const fair =
    side === 'call'
      ? black76Call(forward, strike, timeYears, sigmaOffered)
      : black76Put(forward, strike, timeYears, sigmaOffered)
  const capital = side === 'call' ? spot : strike
  const user = Math.max(0, fair * (1 - baseHaircut))
  const apr = calculateAPR(user, capital, daysToExpiry)
  return { fair, capital, apr }
}

/**
 * Server-canonical option quote. Pure and deterministic given its inputs — the
 * async market data (σ, forward) is fetched by the callers below and passed in,
 * which keeps this unit-testable and keeps the money path auditable.
 */
export function quoteOption(input: QuoteInput): Quote {
  const { side, spot, strike, daysToExpiry, sigmaRealized } = input

  if (!isFinite(spot) || spot <= 0) throw new Error('quoteOption: invalid spot')
  if (!isFinite(strike) || strike <= 0) throw new Error('quoteOption: invalid strike')
  if (!isFinite(daysToExpiry) || daysToExpiry <= 0) throw new Error('quoteOption: invalid daysToExpiry')
  if (side !== 'call' && side !== 'put') throw new Error('quoteOption: invalid side')
  if (!isFinite(sigmaRealized) || sigmaRealized <= 0) throw new Error('quoteOption: invalid sigmaRealized')

  const forward =
    isFinite(input.forward as number) && (input.forward as number) > 0
      ? (input.forward as number)
      : spot
  const utilization = Math.max(0, Math.min(1, input.utilization ?? 0))
  const timeYears = daysToExpiry / 365

  const sigmaOffered = offeredVol(sigmaRealized)

  // Base haircut: protocol edge + safety + utilization response.
  const baseHaircut = Math.max(
    HAIRCUT_MIN,
    Math.min(HAIRCUT_MAX, HAIRCUT_BASE + utilizationMargin(utilization)),
  )

  // This strike's raw (un-normalized) Black-76 APR.
  const self = rawStrike(side, forward, spot, strike, timeYears, daysToExpiry, sigmaOffered, baseHaircut)

  // Reference = the nearest strike (index 0 of the ladder), whose raw APR is the
  // ladder maximum. We pin it to the time-scaled MAX_APR target and scale every
  // strike by the same factor — so the top strike lands on target and the rest
  // fall away in a smooth, distinct gradient (no two strikes share a number).
  // This is computable from (spot, days, σ, util) alone, so the deposit route
  // reproduces the exact same scaling for any strike it reprices.
  const nearMult = side === 'call' ? CALL_STRIKE_MULTIPLIERS[0] : PUT_STRIKE_MULTIPLIERS[0]
  const nearStrike = roundStrike(spot * nearMult, spot)
  const ref = rawStrike(side, forward, spot, nearStrike, timeYears, daysToExpiry, sigmaOffered, baseHaircut)

  // Time-scaled ceiling for the top strike (longer tenor → higher target).
  const timeRefDays =
    input.timeRefDays && input.timeRefDays > 0 ? input.timeRefDays : resolveTimeRefDays()
  const targetTop = MAX_APR * Math.min(1, daysToExpiry / timeRefDays)
  const scaleFactor = ref.apr > 0 ? Math.min(1, targetTop / ref.apr) : 1

  // Gross offered APR after ladder normalization, hard-clamped to the ceiling.
  // The clamp matters for SECURITY: a client could submit an off-ladder strike
  // (near-ATM or ITM) whose raw APR scales above the nearest rung; without this
  // bound it would price — and pay — well above the displayed cap. The nearest
  // ladder rung already sits exactly at targetTop, so this is a no-op for it.
  const grossApr = Math.min(self.apr * scaleFactor, targetTop)
  const aprCapped = scaleFactor < 1 || self.apr * scaleFactor > targetTop
  const capital = self.capital
  const fairPremium = self.fair
  const grossUpfront = capital * (grossApr / 100) * (daysToExpiry / 365)

  // Apply the explicit protocol commission: the user receives the upfront net of
  // the fee; APR is reduced by the same fraction so displayed == paid.
  const apr = grossApr * (1 - PREMIUM_FEE_RATE)
  const userPremium = grossUpfront * (1 - PREMIUM_FEE_RATE)
  const protocolFee = grossUpfront - userPremium

  // Implicit edge (below-fair pricing, realized at settlement) is separate from
  // the explicit fee and measured against the gross upfront.
  const protocolEdge = fairPremium - grossUpfront
  const haircut = fairPremium > 0 ? 1 - grossUpfront / fairPremium : baseHaircut

  return {
    side,
    spot,
    forward,
    strike,
    daysToExpiry,
    sigmaRealized,
    sigmaOffered,
    fairPremium,
    haircut,
    userPremium,
    protocolEdge,
    capital,
    utilization,
    apr,
    aprCapped,
    protocolFee,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Market-data wrappers (async). Routes call these.
// ────────────────────────────────────────────────────────────────────────────

export interface MarketContext {
  spot: number
  forward: number
  sigmaRealized: number
  sigmaOffered: number
  fundingAnnual: number
  forwardSource: 'perp-funding' | 'spot-fallback'
  volMethod: string
  volWindowDays: number
  asOf: number
}

/**
 * Fetch the live market inputs (σ from XLM history, forward from perp) for a
 * given spot and expiry. One call feeds both the ladder and single quotes so
 * the same σ/forward back the whole screen.
 */
export async function getMarketContext(
  spot: number,
  daysToExpiry: number,
): Promise<MarketContext> {
  const timeYears = daysToExpiry / 365
  const [rv, fwd] = await Promise.all([getRealizedVol(), getForward(spot, timeYears)])
  return {
    spot,
    forward: fwd.forward,
    sigmaRealized: rv.sigma,
    sigmaOffered: offeredVol(rv.sigma),
    fundingAnnual: fwd.fundingAnnual,
    forwardSource: fwd.source,
    volMethod: rv.method,
    volWindowDays: rv.windowDays,
    asOf: rv.asOf,
  }
}

/** A priced rung in the strike ladder. */
export interface LadderRung extends Quote {
  index: number
  label: string
}

/**
 * Full strike ladder for the earn UI, priced with real σ/forward. `utilization`
 * is the per-expiry pool utilization (the UI passes what it shows; the deposit
 * route recomputes the same from on-chain state), so the displayed APR equals
 * the paid APR.
 */
export async function quoteLadder(
  side: 'call' | 'put',
  spot: number,
  daysToExpiry: number,
  utilization: number = 0,
): Promise<{ context: MarketContext; rungs: LadderRung[] }> {
  const context = await getMarketContext(spot, daysToExpiry)
  const mults = side === 'call' ? CALL_STRIKE_MULTIPLIERS : PUT_STRIKE_MULTIPLIERS
  const rungs = mults.map((mult, index) => {
    const strike = roundStrike(spot * mult, spot)
    const q = quoteOption({
      side,
      spot,
      forward: context.forward,
      strike,
      daysToExpiry,
      sigmaRealized: context.sigmaRealized,
      utilization,
    })
    const label = side === 'call' ? callStrikeLabel(mult) : putStrikeLabel(mult)
    return { ...q, index, label }
  })
  return { context, rungs }
}

/** Single authoritative quote for a specific strike, fetching live market data. */
export async function quoteOptionLive(input: {
  side: 'call' | 'put'
  spot: number
  strike: number
  daysToExpiry: number
  utilization?: number
}): Promise<{ context: MarketContext; quote: Quote }> {
  const context = await getMarketContext(input.spot, input.daysToExpiry)
  const quote = quoteOption({
    side: input.side,
    spot: input.spot,
    forward: context.forward,
    strike: input.strike,
    daysToExpiry: input.daysToExpiry,
    sigmaRealized: context.sigmaRealized,
    utilization: input.utilization ?? 0,
  })
  return { context, quote }
}
