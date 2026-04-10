// Black-Scholes pricing in TypeScript for frontend display
// Mirrors the Soroban contract logic but uses JS floats

export function normalCDF(x: number): number {
  const a1 =  0.254829592
  const a2 = -0.284496736
  const a3 =  1.421413741
  const a4 = -1.453152027
  const a5 =  1.061405429
  const p  =  0.3275911

  const sign = x < 0 ? -1 : 1
  x = Math.abs(x)

  const t = 1.0 / (1.0 + p * x)
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)

  return 0.5 * (1.0 + sign * y)
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

// Volatility smile: deep OTM strikes need a higher effective IV than ATM.
// iv_eff = iv_base × (1 + SMILE_K × ln(K/S)^2)
// SMILE_K calibrated so a ±60% strike roughly doubles the base IV.
export const SMILE_K = 6.0

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

export function effectiveIv(baseIv: number, spot: number, strike: number): number {
  if (spot <= 0 || strike <= 0) return baseIv
  const m = Math.log(strike / spot)
  return baseIv * (1 + SMILE_K * m * m)
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

export function generateCallStrikes(
  spotPrice: number,
  impliedVol: number = 0.80,
  daysToExpiry: number = 7
): StrikeOption[] {
  const timeYears = daysToExpiry / 365
  // Closest-to-spot first → highest APR (and assignment risk).
  const multipliers = [1.02, 1.06, 1.12, 1.20]

  return multipliers.map((mult, i) => {
    const strike = roundStrike(spotPrice * mult, spotPrice)
    const ivEff = effectiveIv(impliedVol, spotPrice, strike)
    const grossPremium = blackScholesCall(spotPrice, strike, timeYears, ivEff)
    const premium = grossPremium * (1 - PROTOCOL_FEE)
    const apr = calculateAPR(premium, spotPrice, daysToExpiry)
    const pctOtm = ((mult - 1) * 100).toFixed(0)
    const label = `+${pctOtm}% OTM`
    return { index: i, strike, premium, apr, label }
  })
}

export function generatePutStrikes(
  spotPrice: number,
  impliedVol: number = 0.80,
  daysToExpiry: number = 7
): StrikeOption[] {
  const timeYears = daysToExpiry / 365
  // Furthest-from-spot first → safest, lowest APR; last is closest to spot.
  const multipliers = [0.80, 0.88, 0.94, 0.98]

  return multipliers.map((mult, i) => {
    const strike = roundStrike(spotPrice * mult, spotPrice)
    const ivEff = effectiveIv(impliedVol, spotPrice, strike)
    const grossPremium = blackScholesPut(spotPrice, strike, timeYears, ivEff)
    const premium = grossPremium * (1 - PROTOCOL_FEE)
    const apr = calculateAPR(premium, spotPrice, daysToExpiry)
    const pctOtm = ((1 - mult) * 100).toFixed(0)
    const label = `-${pctOtm}% OTM`
    return { index: i, strike, premium, apr, label }
  })
}
