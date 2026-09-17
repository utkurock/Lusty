// What makes a declared asset unservable.
// =======================================
// A registry entry is a promise that every rail downstream can be pointed at
// this asset and will do the right thing. Nothing checked that promise. The
// old gate asked two questions — is there an issuer, are the three contracts
// named — and anything else wrong with a declaration was discovered by the
// code that tripped over it, one rail at a time, at whatever hour somebody
// tried to write a position.
//
// That is the wrong moment to find out. A ladder declared with no rungs is a
// screen with no strikes; a `maxSize` above the per-wallet epoch allowance is
// a size the screen offers and the quoter refuses; a contract id that is not a
// strkey is an RPC error with no asset's name on it. All three are visible in
// the declaration, before a single request is served.
//
// So the whole declaration is checked once, at load, and an asset that fails
// is gated with its reasons attached rather than left live and broken. Two
// kinds, because they are fixed by different people:
//
//   `unconfigured`  the deployment has not supplied a value yet. Expected on a
//                   fresh environment, and how BTC sat for most of Tranche 2.
//   `invalid`       the value that is there cannot be right whatever the
//                   environment says. That is a bug somebody shipped.
//
// Gating an asset takes one book offline and leaves the others up, which is
// the cheap failure. Serving a book whose configuration contradicts itself is
// the expensive one.

import { StrKey } from '@stellar/stellar-sdk'
import type { AssetIssue, UnderlyingAsset } from './schema'

/** The asset as resolved, before it is known whether it can be served. */
export type ResolvedAsset = Omit<UnderlyingAsset, 'enabled' | 'issues'>

// Amounts are decimal numbers standing in for i128 at seven decimals, so
// anything below a stroop is float noise rather than a real inequality.
const EPSILON = 1e-7

const SYMBOL = /^[A-Z0-9]{1,12}$/
const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/

class Issues {
  readonly list: AssetIssue[] = []

  missing(field: string, reason: string) {
    this.list.push({ kind: 'unconfigured', field, reason })
  }

  invalid(field: string, reason: string) {
    this.list.push({ kind: 'invalid', field, reason })
  }

  /** A positive finite number, which every size, cap and tick has to be. */
  positive(field: string, value: number) {
    if (!isFinite(value) || value <= 0) {
      this.invalid(field, `must be a positive number, got ${value}`)
      return false
    }
    return true
  }

  atLeast(field: string, value: number, floor: number, why: string) {
    if (value + EPSILON < floor) {
      this.invalid(field, `${why} (${value} < ${floor})`)
    }
  }

  wholeNumber(field: string, value: number, floor: number) {
    if (!Number.isInteger(value) || value < floor) {
      this.invalid(field, `must be a whole number of at least ${floor}, got ${value}`)
    }
  }
}

/** A contract id: absent is unconfigured, present-and-malformed is a bug. */
function checkContract(issues: Issues, field: string, id: string, why: string) {
  if (!id) {
    issues.missing(field, why)
    return
  }
  if (!StrKey.isValidContract(id)) {
    issues.invalid(field, `is not a contract address: ${id}`)
  }
}

/**
 * A ladder walks away from the money and never turns back. Strictly monotonic
 * because two rungs at one strike are one rung the screen draws twice, and a
 * rung that steps back toward the money prices above the one before it, which
 * is the ladder normalization in pricing-server reading a maximum that is not
 * at index 0.
 */
function checkLadder(
  issues: Issues,
  field: string,
  rungs: number[],
  side: 'call' | 'put'
) {
  if (rungs.length === 0) {
    issues.invalid(field, 'has no rungs, so the screen would show no strikes')
    return
  }
  const otm = side === 'call' ? (m: number) => m > 1 : (m: number) => m > 0 && m < 1
  if (!rungs.every(otm)) {
    issues.invalid(
      field,
      side === 'call'
        ? `must all be above spot, got ${rungs.join(', ')}`
        : `must all be between zero and spot, got ${rungs.join(', ')}`
    )
    return
  }
  const monotonic = rungs.every((m, i) =>
    i === 0 ? true : side === 'call' ? m > rungs[i - 1] : m < rungs[i - 1]
  )
  if (!monotonic) {
    issues.invalid(field, `must step away from the money in order, got ${rungs.join(', ')}`)
  }
}

/**
 * Every reason this asset cannot be served, in the order a reader would want
 * them: who it is, where it settles, what it escrows, how it is priced, and
 * what it is allowed to write. Empty means servable.
 */
export function validateAsset(a: ResolvedAsset): AssetIssue[] {
  const issues = new Issues()

  // Identity. The symbol is a Map key and the slug is a URL segment, so both
  // are matched rather than trusted.
  if (!SYMBOL.test(a.symbol)) {
    issues.invalid('symbol', `must be 1-12 upper-case letters or digits, got "${a.symbol}"`)
  }
  if (!SLUG.test(a.slug)) {
    issues.invalid('slug', `must be a lower-case URL segment, got "${a.slug}"`)
  }
  if (!a.name.trim()) issues.invalid('name', 'is empty')

  // Where it settles. No vault means no book; no cash means no premium can be
  // paid; no token means a call has nothing to escrow.
  checkContract(issues, 'contracts.vault', a.contracts.vault, 'no vault instance is deployed for this book')
  checkContract(issues, 'contracts.token', a.contracts.token, 'the collateral a call escrows has no SAC')
  checkContract(issues, 'contracts.cash', a.contracts.cash, 'the asset premiums are paid in has no SAC')

  // What it escrows.
  if (a.stellarAsset.kind === 'issued') {
    const { code, issuer } = a.stellarAsset
    if (!code || code.length > 12) {
      issues.invalid('stellarAsset.code', `must be a 1-12 character asset code, got "${code}"`)
    }
    if (!issuer) {
      issues.missing('stellarAsset.issuer', 'nobody anchors this asset yet')
    } else if (!StrKey.isValidEd25519PublicKey(issuer)) {
      issues.invalid('stellarAsset.issuer', `is not an account address: ${issuer}`)
    }
  }

  // How it is priced. The feed is the settlement price source, so an empty one
  // is an asset that could be written and never settled.
  if (!a.feedSymbol.trim()) {
    issues.invalid('feedSymbol', 'names no Reflector feed, so nothing could settle this book')
  }
  if (!a.binanceSymbol.trim()) {
    issues.invalid('binanceSymbol', 'names no market for the quote inputs')
  }
  if (!a.coingeckoId.trim()) {
    issues.invalid('coingeckoId', 'names no second source for the realized-vol series')
  }

  // How it is counted. Showing more decimals than the amount is booked in
  // invents precision the ledger does not carry.
  issues.wholeNumber('unitDecimals', a.unitDecimals, 0)
  issues.wholeNumber('displayDecimals', a.displayDecimals, 0)
  if (a.displayDecimals > a.unitDecimals) {
    issues.invalid(
      'displayDecimals',
      `shows more precision than the book carries (${a.displayDecimals} > ${a.unitDecimals})`
    )
  }

  // The ladder and the schedule.
  checkLadder(issues, 'strike.callOtm', a.strike.callOtm, 'call')
  checkLadder(issues, 'strike.putOtm', a.strike.putOtm, 'put')
  if (issues.positive('strike.tickFraction', a.strike.tickFraction) && a.strike.tickFraction >= 1) {
    issues.invalid('strike.tickFraction', `is a fraction of spot, got ${a.strike.tickFraction}`)
  }
  issues.wholeNumber('expiry.openExpiries', a.expiry.openExpiries, 1)
  issues.positive('expiry.minDaysToExpiry', a.expiry.minDaysToExpiry)
  issues.positive('expiry.tenorDays', a.expiry.tenorDays)

  // What it is allowed to write. Each of these is a bound the screen refuses
  // against, and a bound that contradicts another is a position a user is
  // offered and then denied.
  const sizes: Array<[string, number]> = [
    ['minSize', a.minSize],
    ['maxSize', a.maxSize],
    ['userEpochCall', a.userEpochCall],
    ['maxSizeCash', a.maxSizeCash],
    ['userEpochPutUsd', a.userEpochPutUsd],
    ['callMonthlyCap', a.callMonthlyCap],
    ['putMonthlyCapUsd', a.putMonthlyCapUsd],
  ]
  for (const [field, value] of sizes) issues.positive(field, value)

  issues.atLeast('maxSize', a.maxSize, a.minSize, 'the largest position is below the smallest one')
  issues.atLeast(
    'userEpochCall',
    a.userEpochCall,
    a.maxSize,
    "a wallet's call allowance for one expiry is below a single position"
  )
  issues.atLeast(
    'userEpochPutUsd',
    a.userEpochPutUsd,
    a.maxSizeCash,
    "a wallet's put allowance for one expiry is below a single position"
  )
  issues.atLeast(
    'callMonthlyCap',
    a.callMonthlyCap,
    a.maxSize,
    'the call book has less capacity for a month than for one position'
  )
  issues.atLeast(
    'putMonthlyCapUsd',
    a.putMonthlyCapUsd,
    a.maxSizeCash,
    'the put book has less capacity for a month than for one position'
  )

  // The record of the instance's own limits. Whether it matches the instance
  // is lib/vault-limits' question and needs the network; that it is a usable
  // set of numbers is this one's.
  const limits = a.onchainLimits
  for (const field of [
    'maxPositionCall',
    'maxPositionPut',
    'maxExpiryCall',
    'maxExpiryPut',
    'maxPremiumBps',
  ] as const) {
    issues.positive(`onchainLimits.${field}`, limits[field])
  }
  if (limits.maxPremiumBps > 10_000) {
    issues.invalid(
      'onchainLimits.maxPremiumBps',
      `would let a premium exceed the collateral behind it (${limits.maxPremiumBps} bps)`
    )
  }

  return issues.list
}

/** One line per reason, for a log or a health payload. */
export function describeIssues(issues: AssetIssue[]): string[] {
  return issues.map((i) => `${i.field} ${i.reason}`)
}
