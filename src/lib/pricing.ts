// Black-Scholes pricing in TypeScript for frontend display
// Mirrors the Soroban contract logic but uses JS floats

export function normalCDF(x: number): number {
  // Standard normal CDF via the Abramowitz-Stegun 7.1.26 erf approximation:
  //   Φ(x) = ½ · (1 + erf(x / √2))
  // The /√2 rescale is essential — erf alone is the CDF of N(0, ½), not the
  // standard normal. Without it every Black-76 d1/d2 probability is pushed
  // toward 0/1 (as if σ were ~√2 larger) and fair premiums come out inflated.
  const a1 =  0.254829592
  const a2 = -0.284496736
  const a3 =  1.421413741
  const a4 = -1.453152027
  const a5 =  1.061405429
  const p  =  0.3275911

  const sign = x < 0 ? -1 : 1
  const z = Math.abs(x) / Math.SQRT2

  const t = 1.0 / (1.0 + p * z)
  const erf = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z)

  return 0.5 * (1.0 + sign * erf)
}

export function blackScholesCall(
  spot: number,
  strike: number,
  timeYears: number,
  vol: number,
  rate: number = 0.05
): number {
  if (timeYears <= 0) return Math.max(spot - strike, 0)

  const d1 = (Math.log(spot / strike) + (rate + 0.5 * vol * vol) * timeYears) / (vol * Math.sqrt(timeYears))
  const d2 = d1 - vol * Math.sqrt(timeYears)

  return spot * normalCDF(d1) - strike * Math.exp(-rate * timeYears) * normalCDF(d2)
}

export function blackScholesPut(
  spot: number,
  strike: number,
  timeYears: number,
  vol: number,
  rate: number = 0.05
): number {
  if (timeYears <= 0) return Math.max(strike - spot, 0)

  const d1 = (Math.log(spot / strike) + (rate + 0.5 * vol * vol) * timeYears) / (vol * Math.sqrt(timeYears))
  const d2 = d1 - vol * Math.sqrt(timeYears)

  return strike * Math.exp(-rate * timeYears) * normalCDF(-d2) - spot * normalCDF(-d1)
}

// ────────────────────────────────────────────────────────────────────────────
// Black-76 — forward-based option pricing. THE canonical pricer for Lusty.
//
// Unlike Black-Scholes it prices off the forward F (carry baked in via the perp
// funding rate — see forward.ts) instead of spot + an assumed risk-free rate.
// The discount factor e^(-rT) is negligible for short-dated XLM weeklies, so we
// default the discount rate to 0: the carry lives in F, not in a rate we don't
// actually have. This removes the arbitrary r=0.05 the old BS path assumed.
//
//   d1 = [ln(F/K) + (σ²/2)·T] / (σ·√T)
//   d2 = d1 − σ·√T
//   Call = e^(−rT)·[F·N(d1) − K·N(d2)]
//   Put  = e^(−rT)·[K·N(−d2) − F·N(−d1)]
//
// Put-call parity sanity check: Call − Put = e^(−rT)·(F − K).
// ────────────────────────────────────────────────────────────────────────────

export const DISCOUNT_RATE = 0 // carry is in the forward; short-dated → e^(-rT)≈1

export function black76Call(
  forward: number,
  strike: number,
  timeYears: number,
  vol: number,
  rate: number = DISCOUNT_RATE
): number {
  if (timeYears <= 0) return Math.max(forward - strike, 0)
  const sqrtT = vol * Math.sqrt(timeYears)
  if (sqrtT <= 0) return Math.max(forward - strike, 0) * Math.exp(-rate * timeYears)
  const d1 = (Math.log(forward / strike) + 0.5 * vol * vol * timeYears) / sqrtT
  const d2 = d1 - sqrtT
  return Math.exp(-rate * timeYears) * (forward * normalCDF(d1) - strike * normalCDF(d2))
}

export function black76Put(
  forward: number,
  strike: number,
  timeYears: number,
  vol: number,
  rate: number = DISCOUNT_RATE
): number {
  if (timeYears <= 0) return Math.max(strike - forward, 0)
  const sqrtT = vol * Math.sqrt(timeYears)
  if (sqrtT <= 0) return Math.max(strike - forward, 0) * Math.exp(-rate * timeYears)
  const d1 = (Math.log(forward / strike) + 0.5 * vol * vol * timeYears) / sqrtT
  const d2 = d1 - sqrtT
  return Math.exp(-rate * timeYears) * (strike * normalCDF(-d2) - forward * normalCDF(-d1))
}

// ────────────────────────────────────────────────────────────────────────────
// Black-76 Greeks — sensitivities of the FAIR value priced above.
//
// Analytic derivatives of the same two formulas, evaluated at whatever σ the
// caller passes in. Lusty passes the per-strike σ off the smile, so vega here
// is ∂P/∂σ_K: the response to THIS strike's vol moving with the rest of the
// curve held still. It is not ∂P/∂σ_atm, which would need the smile's own
// derivative as well. Sticky-strike is the right convention at this book size,
// but reading one number for the other overstates a parallel vol shock.
//
//   d1    = [ln(F/K) + (σ²/2)·T] / (σ·√T)
//   Δcall = e^(−rT)·N(d1)          Δput = e^(−rT)·[N(d1) − 1]
//   ν     = e^(−rT)·F·φ(d1)·√T     identical for calls and puts
//
// SIGN: these are the option's Greeks from the HOLDER's side. A Lusty writer is
// short the option, so their exposure is the negative of what these return.
// Nothing in this file flips that sign — the negation happens once, in the
// layer that knows whose book it is describing.
// ────────────────────────────────────────────────────────────────────────────

/** Standard normal PDF φ(x). */
export function normalPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
}

function black76D1(forward: number, strike: number, timeYears: number, vol: number): number {
  const sqrtT = vol * Math.sqrt(timeYears)
  return (Math.log(forward / strike) + 0.5 * vol * vol * timeYears) / sqrtT
}

// True when the pricing inputs cannot produce a finite d1 (expired, zero vol,
// non-positive forward or strike). Callers fall back to the degenerate case.
function degenerate(forward: number, strike: number, timeYears: number, vol: number): boolean {
  return !(timeYears > 0) || !(vol > 0) || !(forward > 0) || !(strike > 0)
}

/**
 * ∂P/∂F. Call delta runs 0..1, put delta −1..0.
 *
 * At expiry (or zero vol) the option is a step function of the forward, so
 * delta collapses to its intrinsic side: 1/0 for a call, 0/−1 for a put.
 * Exactly at the strike the derivative does not exist — the step is there — and
 * 0 is returned rather than picking a side the position does not have.
 */
export function black76Delta(
  side: 'call' | 'put',
  forward: number,
  strike: number,
  timeYears: number,
  vol: number,
  rate: number = DISCOUNT_RATE
): number {
  if (degenerate(forward, strike, timeYears, vol)) {
    if (!(forward > 0) || !(strike > 0)) return 0
    const itm = side === 'call' ? forward > strike : forward < strike
    if (!itm) return 0
    return side === 'call' ? 1 : -1
  }
  const df = Math.exp(-rate * timeYears)
  const nd1 = normalCDF(black76D1(forward, strike, timeYears, vol))
  return side === 'call' ? df * nd1 : df * (nd1 - 1)
}

/**
 * ∂P/∂σ, per unit of σ (1.00 = 100 vol points) and per unit notional — the same
 * basis the premiums above are quoted on. Divide by 100 for a per-vol-point
 * figure. Positive for both legs: an option is worth more when vol rises,
 * whichever side it is. A writer is short this.
 */
export function black76Vega(
  forward: number,
  strike: number,
  timeYears: number,
  vol: number,
  rate: number = DISCOUNT_RATE
): number {
  if (degenerate(forward, strike, timeYears, vol)) return 0
  const df = Math.exp(-rate * timeYears)
  const d1 = black76D1(forward, strike, timeYears, vol)
  return df * forward * normalPDF(d1) * Math.sqrt(timeYears)
}

// Protocol revenue share taken from every premium (25% of Black-Scholes
// fair value). The user receives 75% of the BS premium; the remaining 25%
// is the protocol's edge — paid to FEE_WALLET on every successful deposit.
//
// Why 25% (not 15%)?
//   * BS assumes constant vol; XLM realized vol can spike, so we need
//     headroom to absorb tail-risk losses on the long-call inventory.
//   * The vault has no external hedging — every undercharged option is
//     a real loss if it expires deep ITM.
//   * 25% leaves the offered APR competitive while keeping the protocol
//     positive-EV across most realized-vol regimes (verified in /research).
export const PROTOCOL_FEE_BPS = 2500 // 25.00%
export const PROTOCOL_FEE = PROTOCOL_FEE_BPS / 10_000

// NOTE: the pricers above take σ as given and apply no smile of their own. The
// old `iv_eff = iv_base × (1 + SMILE_K × ln(K/S)²)` hack was invented and is
// gone. A fitted shape now lives in smile.ts — borrowed in standardised
// moneyness from surfaces that actually trade — and the server engine applies
// it per strike before calling in here. Keeping that choice out of the pricer
// is what lets the Greeks be evaluated at exactly the σ the caller priced at.

// Round a strike to a Deribit-style "nice" tick size based on the spot price.
// The tick is chosen from a 1-2-5 ladder so strikes like $0.23, $42, $1500
// always look clean instead of $0.1768 / $41.7 / $1497.3.
export function niceStrikeStep(spot: number): number {
  if (spot <= 0) return 1
  // Aim for a tick that is roughly 1% of spot.
  const target = spot * 0.01
  const exp = Math.floor(Math.log10(target))
  const base = Math.pow(10, exp)
  const norm = target / base
  let mult: number
  if (norm < 1.5) mult = 1
  else if (norm < 3.5) mult = 2
  else if (norm < 7.5) mult = 5
  else mult = 10
  return mult * base
}

export function roundStrike(strike: number, spot: number): number {
  const step = niceStrikeStep(spot)
  return Math.round(strike / step) * step
}

export function calculateAPR(
  premiumUsdc: number,
  assetValueUsdc: number,
  daysToExpiry: number
): number {
  if (assetValueUsdc === 0 || daysToExpiry === 0) return 0
  return (premiumUsdc / assetValueUsdc) * (365 / daysToExpiry) * 100
}

export interface StrikeOption {
  index: number
  strike: number
  premium: number
  apr: number
  label: string
}

// Strike ladders. The OTM multipliers below define the rungs; the canonical
// pricing/APR for each rung comes from the server engine (quote.ts via
// /api/vault/quote) using real realized vol + forward, so what the user sees
// equals what the vault pays. These exported ladder definitions are shared so
// the server and any client preview agree on the strike set.
export const CALL_STRIKE_MULTIPLIERS = [1.02, 1.06, 1.12, 1.20]
export const PUT_STRIKE_MULTIPLIERS = [0.98, 0.94, 0.88, 0.80]

export function callStrikeLabel(mult: number): string {
  return `+${((mult - 1) * 100).toFixed(0)}% OTM`
}
export function putStrikeLabel(mult: number): string {
  return `-${((1 - mult) * 100).toFixed(0)}% OTM`
}

// Legacy synchronous preview ladders. Kept for non-authoritative previews only
// (forward defaults to spot, flat σ, no utilization haircut). The live earn UI
// fetches /api/vault/quote instead so the displayed APR is the paid APR.
export function generateCallStrikes(
  spotPrice: number,
  impliedVol: number = 0.80,
  daysToExpiry: number = 7
): StrikeOption[] {
  const timeYears = daysToExpiry / 365
  return CALL_STRIKE_MULTIPLIERS.map((mult, i) => {
    const strike = roundStrike(spotPrice * mult, spotPrice)
    const premium = black76Call(spotPrice, strike, timeYears, impliedVol)
    const apr = calculateAPR(premium, spotPrice, daysToExpiry)
    return { index: i, strike, premium, apr, label: callStrikeLabel(mult) }
  })
}

export function generatePutStrikes(
  spotPrice: number,
  impliedVol: number = 0.80,
  daysToExpiry: number = 7
): StrikeOption[] {
  const timeYears = daysToExpiry / 365
  return PUT_STRIKE_MULTIPLIERS.map((mult, i) => {
    const strike = roundStrike(spotPrice * mult, spotPrice)
    const premium = black76Put(spotPrice, strike, timeYears, impliedVol)
    // Cash-secured put: capital at risk is the strike (cash locked), not spot.
    const apr = calculateAPR(premium, strike, daysToExpiry)
    return { index: i, strike, premium, apr, label: putStrikeLabel(mult) }
  })
}
