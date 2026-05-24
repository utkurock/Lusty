// Server-side quote engine. Every premium the vault pays out must flow
// through `quoteOption()` so the API endpoints never trust client-supplied
// pricing fields. Mirrors the display math in pricing.ts (Black-Scholes
// with volatility smile + flat protocol fee) but lives behind the server
// boundary where the values become authoritative.
//
// The base IV is server-configured (BASE_IV env var) so a future commit
// can swap in a realized-vol proxy without touching call sites.

import {
  blackScholesCall,
  blackScholesPut,
  effectiveIv,
  calculateAPR,
  PROTOCOL_FEE,
} from './pricing'

const DEFAULT_BASE_IV = 0.80 // 80% annualized — matches pricing.ts UI default
const DEFAULT_RATE = 0.05    // 5% risk-free rate — matches pricing.ts default

export interface QuoteInput {
  side: 'call' | 'put'
  spot: number
  strike: number
  daysToExpiry: number
}

export interface Quote {
  side: 'call' | 'put'
  spot: number
  strike: number
  daysToExpiry: number
  /** Base IV used (annualized, decimal). */
  baseIv: number
  /** Smile-adjusted IV at this strike (annualized, decimal). */
  ivEff: number
  /** Black-Scholes fair premium per unit notional (USD). */
  grossPremium: number
  /** What the user receives per unit notional (USD). */
  userPremium: number
  /** Protocol fee per unit notional (USD). */
  fee: number
  /** Annualized APR offered to the user (percent, e.g. 26.03). */
  apr: number
}

function baseIvFromEnv(): number {
  const raw = Number(process.env.BASE_IV)
  if (isFinite(raw) && raw > 0 && raw < 10) return raw
  return DEFAULT_BASE_IV
}

/**
 * Server-canonical option quote. Every code path that pays a premium MUST
 * route through this function — never accept a client-supplied APR or
 * premium and use it directly.
 */
export function quoteOption(input: QuoteInput): Quote {
  const { side, spot, strike, daysToExpiry } = input

  if (!isFinite(spot) || spot <= 0) {
    throw new Error('quoteOption: invalid spot')
  }
  if (!isFinite(strike) || strike <= 0) {
    throw new Error('quoteOption: invalid strike')
  }
  if (!isFinite(daysToExpiry) || daysToExpiry <= 0) {
    throw new Error('quoteOption: invalid daysToExpiry')
  }
  if (side !== 'call' && side !== 'put') {
    throw new Error('quoteOption: invalid side')
  }

  const baseIv = baseIvFromEnv()
  const ivEff = effectiveIv(baseIv, spot, strike)
  const timeYears = daysToExpiry / 365

  const grossPremium =
    side === 'call'
      ? blackScholesCall(spot, strike, timeYears, ivEff, DEFAULT_RATE)
      : blackScholesPut(spot, strike, timeYears, ivEff, DEFAULT_RATE)

  const userPremium = grossPremium * (1 - PROTOCOL_FEE)
  const fee = grossPremium - userPremium

  // For puts, premium and "asset value" are both in quote currency; for
  // calls, the user puts up XLM but premium is in USD, so the per-unit APR
  // calc uses spot as the reference notional. Matches pricing.ts behavior.
  const apr = calculateAPR(userPremium, spot, daysToExpiry)

  return {
    side,
    spot,
    strike,
    daysToExpiry,
    baseIv,
    ivEff,
    grossPremium,
    userPremium,
    fee,
    apr,
  }
}
