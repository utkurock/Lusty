// Lusty APR Engine
// ----------------
// Dynamic premium / APR optimization for the Lusty option vaults.
//
// Goal: maximize protocol revenue (the spread between fair Black-Scholes
// premium and offered premium) while keeping the vault attractive and
// risk-bounded.
//
// Theory (see /research):
//   1. Kinked utilization curve  (Aave/Compound style)
//   2. Inventory skew penalty    (Rysk DHV / Lyra dynamic vAMM)
//   3. Flow momentum dampener    (EMA of net deposits, Avellaneda-Stoikov)
//   4. Cross-strike concentration penalty
//
// The engine outputs an `OfferedStrike` per strike: BS fair APR, the
// margin the protocol keeps, the APR shown to the user, and a confidence
// score so the UI can highlight the most attractive (or most profitable)
// strike at any moment.

import {
  blackScholesCall,
  blackScholesPut,
  calculateAPR,
  effectiveIv,
  PROTOCOL_FEE,
  StrikeOption,
} from './pricing'

// ────────────────────────────────────────────────────────────────────────────
// Tunable parameters
// ────────────────────────────────────────────────────────────────────────────

export interface EngineParams {
  /** Kink point of the utilization curve (0..1). Below = gentle, above = steep. */
  uKink: number
  /** Slope of the margin curve below the kink. */
  slope1: number
  /** Slope of the margin curve above the kink (typically >> slope1). */
  slope2: number
  /** Inventory delta penalty weight. */
  kDelta: number
  /** Inventory vega penalty weight. */
  kVega: number
  /** Concentration penalty weight (HHI based). */
  kConcentration: number
  /** EMA half-life in seconds for net flow. */
  flowHalfLife: number
  /** Flow momentum weight. */
  kFlow: number
  /** Hard caps on offered APR (decimal, e.g. 2.5 = 250%). */
  minApr: number
  maxApr: number
  /** Floor on protocol margin (e.g. 0.05 = always keep ≥5%). */
  minMargin: number
  /** Ceiling on protocol margin (don't gouge users). */
  maxMargin: number
}

export const DEFAULT_PARAMS: EngineParams = {
  uKink: 0.80,
  slope1: 0.10,
  slope2: 0.90,
  kDelta: 0.25,
  kVega: 0.15,
  kConcentration: 0.20,
  flowHalfLife: 600, // 10 minutes
  kFlow: 0.30,
  minApr: 0.02,
  maxApr: 5.0,
  minMargin: 0.05,
  maxMargin: 0.45,
}

// ────────────────────────────────────────────────────────────────────────────
// Vault state inputs
// ────────────────────────────────────────────────────────────────────────────

export interface StrikeState {
  index: number
  strike: number
  /** Notional currently sold against this strike, in vault asset units. */
  utilized: number
  /** Maximum notional this strike can absorb. */
  cap: number
  /** Black-Scholes delta of the option (signed). */
  delta: number
  /** Black-Scholes vega of the option. */
  vega: number
}

export interface VaultState {
  spot: number
  iv: number
  daysToExpiry: number
  /** "call" vault (short calls) or "put" vault (short puts). */
  side: 'call' | 'put'
  strikes: StrikeState[]
  /** Net flow EMA in the last `flowHalfLife` seconds (deposits − withdrawals). */
  netFlowEma: number
  /** Total notional capacity across all strikes. */
  totalCap: number
}

export interface OfferedStrike extends StrikeOption {
  fairApr: number
  /** Fraction of the fair premium the protocol keeps (0..1). */
  margin: number
  /** Protocol revenue per unit notional, in quote asset. */
  protocolEdge: number
  /** Internal score: higher = more profitable for the protocol per $ of capacity used. */
  score: number
  utilization: number
}

// ────────────────────────────────────────────────────────────────────────────
// Margin components
// ────────────────────────────────────────────────────────────────────────────

/** Kinked utilization → margin curve. Output ∈ [0, ~1]. */
export function utilizationMargin(u: number, p: EngineParams): number {
  const uc = Math.max(0, Math.min(1, u))
  if (uc <= p.uKink) {
    return p.slope1 * (uc / p.uKink)
  }
  const over = (uc - p.uKink) / (1 - p.uKink)
  return p.slope1 + p.slope2 * Math.pow(over, 1.5)
}

/** Penalty for adding to an already-skewed inventory. */
export function inventoryPenalty(
  strike: StrikeState,
  vault: VaultState,
  p: EngineParams,
): number {
  const totalDelta = vault.strikes.reduce((s, k) => s + k.delta * k.utilized, 0)
  const totalVega = vault.strikes.reduce((s, k) => s + k.vega * k.utilized, 0)
  const cap = Math.max(vault.totalCap, 1e-9)

  // Direction agreement: if adding this strike's greek pushes inventory
  // further in its current sign, penalty is positive; if it offsets, negative.
  const deltaAlign = Math.sign(totalDelta) === Math.sign(strike.delta) ? 1 : -1
  const vegaAlign = Math.sign(totalVega) === Math.sign(strike.vega) ? 1 : -1

  const dPart = p.kDelta * deltaAlign * Math.abs(totalDelta) / cap
  const vPart = p.kVega * vegaAlign * Math.abs(totalVega) / cap
  return dPart + vPart
}

/** Herfindahl-Hirschman concentration of utilization across strikes. */
export function concentrationPenalty(vault: VaultState, p: EngineParams): number {
  const total = vault.strikes.reduce((s, k) => s + k.utilized, 0)
  if (total <= 0) return 0
  const hhi = vault.strikes.reduce((s, k) => {
    const w = k.utilized / total
    return s + w * w
  }, 0)
  // hhi ∈ [1/n, 1].  Normalize so balanced = 0, fully concentrated = 1.
  const n = vault.strikes.length
  const norm = (hhi - 1 / n) / (1 - 1 / n)
  return p.kConcentration * norm
}

/** Symmetric flow dampener: rapid net inflow lowers offered APR, outflow raises it. */
export function flowAdjustment(vault: VaultState, p: EngineParams): number {
  const cap = Math.max(vault.totalCap, 1e-9)
  return p.kFlow * Math.tanh(vault.netFlowEma / cap)
}

// ────────────────────────────────────────────────────────────────────────────
// Core engine
// ────────────────────────────────────────────────────────────────────────────

export function priceVault(
  vault: VaultState,
  params: Partial<EngineParams> = {},
): OfferedStrike[] {
  const p: EngineParams = { ...DEFAULT_PARAMS, ...params }
  const t = vault.daysToExpiry / 365
  const concPenalty = concentrationPenalty(vault, p)
  const flowAdj = flowAdjustment(vault, p)

  return vault.strikes.map((s) => {
    const u = s.cap > 0 ? s.utilized / s.cap : 0

    const ivEff = effectiveIv(vault.iv, vault.spot, s.strike)
    const grossPremium =
      vault.side === 'call'
        ? blackScholesCall(vault.spot, s.strike, t, ivEff)
        : blackScholesPut(vault.spot, s.strike, t, ivEff)

    // Protocol takes a flat 5% fee off the top before any dynamic margin.
    const fairPremium = grossPremium * (1 - PROTOCOL_FEE)
    const feeRevenue = grossPremium * PROTOCOL_FEE
    const fairApr = calculateAPR(fairPremium, vault.spot, vault.daysToExpiry) / 100

    // Combine all margin sources, then clamp.
    const rawMargin =
      utilizationMargin(u, p) +
      inventoryPenalty(s, vault, p) +
      concPenalty +
      flowAdj

    const margin = Math.max(p.minMargin, Math.min(p.maxMargin, rawMargin))

    // APR offered to the user = fair × (1 − margin), then clamped.
    const offeredApr = Math.max(
      p.minApr,
      Math.min(p.maxApr, fairApr * (1 - margin)),
    )

    // Total protocol revenue per unit = flat fee + dynamic margin spread.
    const protocolEdge = feeRevenue + fairPremium * margin
    // Score rewards strikes where the protocol earns the most per unit of
    // remaining capacity used — this is what the UI can sort by.
    const remaining = Math.max(s.cap - s.utilized, 1e-9)
    const score = (protocolEdge / remaining) * (1 - u)

    const label =
      vault.side === 'call'
        ? s.strike < vault.spot
          ? 'ITM'
          : 'OTM'
        : s.strike > vault.spot
        ? 'OTM'
        : 'ITM'

    return {
      index: s.index,
      strike: s.strike,
      premium: fairPremium * (1 - margin),
      apr: offeredApr * 100,
      fairApr: fairApr * 100,
      margin,
      protocolEdge,
      score,
      utilization: u,
      label,
    }
  })
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers for tests / UI
// ────────────────────────────────────────────────────────────────────────────

/** Pure-synthetic vault state for previews when there's no real on-chain data. */
export function mockVaultState(
  spot: number,
  side: 'call' | 'put' = 'call',
  daysToExpiry: number = 7,
  iv: number = 0.80,
): VaultState {
  const callMults = [1.15, 1.30, 1.45, 1.60]
  const putMults = [0.85, 0.70, 0.55, 0.40]
  const mults = side === 'call' ? callMults : putMults

  // Synthesize plausible deltas/vegas without re-running BS — close enough for UI.
  const strikes: StrikeState[] = mults.map((m, i) => {
    const strike = spot * m
    const moneyness = side === 'call' ? spot / strike : strike / spot
    const delta = side === 'call' ? Math.min(0.95, 0.5 * moneyness) : -Math.min(0.95, 0.5 * moneyness)
    const vega = 0.4 * Math.exp(-Math.pow(Math.log(moneyness), 2) * 4)
    return {
      index: i,
      strike,
      utilized: 0,
      cap: 1_000_000,
      delta,
      vega,
    }
  })

  return {
    spot,
    iv,
    daysToExpiry,
    side,
    strikes,
    netFlowEma: 0,
    totalCap: strikes.reduce((s, k) => s + k.cap, 0),
  }
}

/** Update an EMA when a flow event arrives. */
export function updateFlowEma(
  prevEma: number,
  flowDelta: number,
  dtSeconds: number,
  halfLifeSeconds: number,
): number {
  const decay = Math.pow(0.5, dtSeconds / halfLifeSeconds)
  return prevEma * decay + flowDelta
}
