/**
 * The volatility smile, borrowed in standardised moneyness.
 *
 * XLM has no options market, so it has no observable surface of its own. What
 * it does have is a realized vol LEVEL (vol.ts). This module supplies the
 * missing SHAPE — how vol varies across strikes at a fixed expiry — taken from
 * a market that does trade one.
 *
 * The source is Derive's live BTC and ETH surfaces (docs.derive.xyz, public
 * `get_tickers`). Derive prices every strike off a raw-SVI curve:
 *
 *     w(k) = a + b·[ρ(k−m) + √((k−m)² + e²)]      k = ln(K / forward)
 *     IV   = √(w / τ)
 *
 * Fitting that to four BTC expiries (9.4d → 58.4d) and three ETH ones gives
 * curves that look nothing alike in `k`, because `k` is not comparable across
 * assets: 10% out of the money is 1.67 standard deviations for BTC at 34% vol
 * and 0.64 for XLM at 90%. Rescaled into STANDARDISED moneyness
 *
 *     z = ln(K/F) / (σ_atm · √T)
 *
 * they collapse onto one curve. Across seven fitted expiries the ratio
 * σ(z)/σ_atm varies by only 0.03–0.11, and on the call side BTC and ETH agree
 * to within 0.046. That stability is what makes borrowing defensible: we are
 * not copying BTC's volatility, only the shape of its smile.
 *
 * A caveat that belongs next to the numbers: the two assets agree least on the
 * PUT wing (1.403 vs 1.287 at z = −2), and that is exactly where cash-secured
 * puts are written. The table below averages them, so the put wing carries more
 * model risk than the call wing. It is still far better than assuming flat vol,
 * which is what this replaces.
 */

/**
 * σ(z)/σ_atm, sampled from the fitted Derive surfaces (BTC and ETH averaged).
 *
 * Per-asset values, for anyone re-deriving this:
 *   z      -2.0   -1.5   -1.0   -0.5    0.0   +0.5   +1.0   +1.5   +2.0
 *   BTC   1.403  1.310  1.212  1.112  1.020  0.969  1.009  1.080  1.158
 *   ETH   1.287  1.206  1.123  1.040  0.997  1.014  1.055  1.105  1.158
 *
 * Note the minimum sits ABOVE the forward (z ≈ +0.5), not at it — Derive's
 * fitted `m` is positive at every expiry. The cheapest vol on the board is a
 * slightly out-of-the-money call, which is exactly where a covered call is
 * written.
 */
const SMILE: ReadonlyArray<readonly [number, number]> = [
  [-2.0, 1.345],
  [-1.5, 1.258],
  [-1.0, 1.168],
  [-0.5, 1.076],
  [0.0, 1.009],
  [0.5, 0.992],
  [1.0, 1.032],
  [1.5, 1.093],
  [2.0, 1.158],
]

/**
 * How much of the smile to apply, 0..1. 1 = the table as fitted; 0 = flat vol,
 * i.e. exactly the behaviour before this module existed. A dial rather than a
 * constant because the shape is borrowed, not measured — if XLM ever gets a
 * real surface this is how it gets turned down.
 */
const SMILE_STRENGTH = (() => {
  const n = Number(process.env.SMILE_STRENGTH)
  return isFinite(n) && n >= 0 && n <= 1 ? n : 1
})()

/**
 * ψ(z) — the multiplier on at-the-money vol at standardised moneyness `z`.
 *
 * Linear between samples, flat outside them. Flat rather than extrapolated
 * because Derive's own curve is clamped past four standard deviations, and
 * because an extrapolated wing is a number nobody has ever traded.
 */
export function smileFactor(z: number): number {
  // NaN has no place on the curve; ±Infinity does — it is the wing, and the
  // clamps below already return exactly that.
  if (Number.isNaN(z)) return 1

  let psi: number
  const first = SMILE[0]
  const last = SMILE[SMILE.length - 1]
  if (z <= first[0]) {
    psi = first[1]
  } else if (z >= last[0]) {
    psi = last[1]
  } else {
    psi = 1
    for (let i = 0; i < SMILE.length - 1; i++) {
      const [z0, p0] = SMILE[i]
      const [z1, p1] = SMILE[i + 1]
      if (z >= z0 && z <= z1) {
        psi = p0 + ((p1 - p0) * (z - z0)) / (z1 - z0)
        break
      }
    }
  }

  // Blend toward flat vol. At strength 0 every strike prices at σ_atm again.
  return 1 + (psi - 1) * SMILE_STRENGTH
}

/**
 * Standardised moneyness of `strike` against `forward`, in units of the
 * at-the-money move expected over the option's life.
 */
export function standardisedMoneyness(
  forward: number,
  strike: number,
  timeYears: number,
  sigmaAtm: number,
): number {
  const denom = sigmaAtm * Math.sqrt(timeYears)
  if (!(denom > 0) || !(forward > 0) || !(strike > 0)) return 0
  return Math.log(strike / forward) / denom
}

/**
 * The vol to price THIS strike at, given the at-the-money level.
 *
 * `sigmaAtm` stays the anchor: it sets the level, and `z` is measured in its
 * units, so the smile cannot feed back on itself.
 */
export function smileVol(
  forward: number,
  strike: number,
  timeYears: number,
  sigmaAtm: number,
): number {
  const z = standardisedMoneyness(forward, strike, timeYears, sigmaAtm)
  return sigmaAtm * smileFactor(z)
}
