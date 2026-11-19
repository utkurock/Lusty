// Reconciling the declared limits with the ones the contract enforces.
// =====================================================================
// Every book keeps its risk limits twice. The instance holds `Limits`, which
// is what actually binds: it is checked on every write and nothing off chain
// can talk it out of a refusal. The registry holds two more records beside it,
// and neither of them binds anything.
//
//   `onchainLimits`   what the instance is supposed to have been deployed
//                     with, so a `set_limits` nobody planned is visible.
//   the envelope      the tighter figures the desk actually quotes inside
//                     (maxSize, the monthly capacity split per expiry).
//
// Two records of one rule agree until they do not, and the way they stop
// agreeing is quiet. An admin widens a cap for one position and forgets it. An
// instance is redeployed from an older branch. A monthly capacity is raised in
// the environment without anyone reading it back against the contract. None of
// those fails at the time; it fails on the write that lands outside the bound
// somebody thought was in force.
//
// So the asset is reconciled against its own instance before it is quoted, and
// drift refuses it. A refused asset is a book nobody can open a position in,
// which is the cheap failure. Quoting against whichever of the two records
// happens to be looser is the expensive one.

import { UnderlyingAsset, allUnderlyings } from './assets'
import { getVaultLimits, getVaultPaused, VaultLimits } from './vault-contract'
import { callEpochCap, putEpochCap, epochsPerMonth } from './vault-state'

/**
 * `declared` means the registry's record of the instance is wrong: the
 * contract is enforcing something other than what this repo says it is.
 * `envelope` means the desk would quote past what the contract will accept,
 * so the position is signed and then reverted on submission.
 */
export type DriftKind = 'declared' | 'envelope'

export interface LimitDrift {
  kind: DriftKind
  field: string
  declared: number
  onchain: number
  detail: string
}

export interface LimitsReconciliation {
  symbol: string
  vault: string
  ok: boolean
  drift: LimitDrift[]
  /** Null when the instance could not be read. */
  onchain: VaultLimits | null
  checkedAt: number
  /** Why the read failed, when it did. */
  error?: string
  /** True when this verdict is a cached one served past its refresh. */
  stale?: boolean
}

// One stroop. Both records are decimal numbers standing in for i128 amounts at
// seven decimals, so anything smaller than a stroop is float noise, not drift.
const EPSILON = 1e-7

function differs(a: number, b: number): boolean {
  return Math.abs(a - b) > EPSILON
}

/**
 * Compare both registry records against one reading of the instance. Pure, so
 * the rule is testable without a network.
 */
export function compareLimits(
  asset: UnderlyingAsset,
  onchain: VaultLimits,
): LimitDrift[] {
  const out: LimitDrift[] = []
  const declared = asset.onchainLimits

  const exact: Array<[Exclude<keyof VaultLimits, 'maxOpenCall' | 'maxOpenPut'>, string]> = [
    ['maxPositionCall', 'largest single call position'],
    ['maxPositionPut', 'largest single put position'],
    ['maxExpiryCall', 'call collateral against one expiry'],
    ['maxExpiryPut', 'put collateral against one expiry'],
    ['maxPremiumBps', 'premium ceiling in bps'],
  ]
  for (const [field, what] of exact) {
    if (differs(declared[field], onchain[field])) {
      out.push({
        kind: 'declared',
        field,
        declared: declared[field],
        onchain: onchain[field],
        detail: `${asset.symbol} declares ${what} at ${declared[field]}, the instance enforces ${onchain[field]}`,
      })
    }
  }

  // The open-interest caps exist on v6 only, so absent is a value here: a
  // declaration without them describes a v5 instance, and pointing it at a v6
  // one (or the other way round) is the record being wrong about which
  // contract it is. NaN stands in for "none" so the detail can say so.
  const open: Array<['maxOpenCall' | 'maxOpenPut', string]> = [
    ['maxOpenCall', 'call open interest across every expiry'],
    ['maxOpenPut', 'put open interest across every expiry'],
  ]
  for (const [field, what] of open) {
    const mine = declared[field] ?? null
    const theirs = onchain[field] ?? null
    const agree = mine === null || theirs === null ? mine === theirs : !differs(mine, theirs)
    if (!agree) {
      out.push({
        kind: 'declared',
        field,
        declared: mine ?? NaN,
        onchain: theirs ?? NaN,
        detail: `${asset.symbol} declares ${what} at ${mine ?? 'none'}, the instance enforces ${theirs ?? 'none'}`,
      })
    }
  }

  // The envelope is allowed to be tighter and is meant to be. Only the other
  // direction is a fault: the desk offering size the contract will not take.
  //
  // The per-expiry figures are where this is easiest to get wrong, because the
  // envelope does not declare one. It declares a monthly capacity and splits it
  // across the expiries the book keeps open at a time, so the number to
  // compare against `max_expiry_*` is that quotient, not the monthly figure.
  const envelope: Array<[string, number, keyof VaultLimits, string]> = [
    ['maxSize', asset.maxSize, 'maxPositionCall', 'a call position'],
    ['maxSizeCash', asset.maxSizeCash, 'maxPositionPut', 'a put position'],
    [
      'callMonthlyCap/epochs',
      callEpochCap(asset),
      'maxExpiryCall',
      `call collateral on one expiry (${asset.callMonthlyCap} a month over ${epochsPerMonth(asset)} expiries)`,
    ],
    [
      'putMonthlyCapUsd/epochs',
      putEpochCap(asset),
      'maxExpiryPut',
      `put collateral on one expiry (${asset.putMonthlyCapUsd} a month over ${epochsPerMonth(asset)} expiries)`,
    ],
    // Across the book the envelope's whole monthly capacity can be open at
    // once, one quotient per open expiry, so that is what meets the leg's
    // open-interest cap. Skipped where the instance has none.
    ['callMonthlyCap', asset.callMonthlyCap, 'maxOpenCall', 'call collateral across every open expiry'],
    ['putMonthlyCapUsd', asset.putMonthlyCapUsd, 'maxOpenPut', 'put collateral across every open expiry'],
  ]
  for (const [field, value, against, what] of envelope) {
    const bound = onchain[against]
    if (bound == null) continue
    if (value - bound > EPSILON) {
      out.push({
        kind: 'envelope',
        field,
        declared: value,
        onchain: bound,
        detail: `${asset.symbol} would quote ${value} for ${what}, the instance caps it at ${bound}`,
      })
    }
  }

  return out
}

// How long a clean reading is trusted before it is taken again, and how long
// one is served after a refresh fails. The grace exists because an RPC that
// cannot be reached is not evidence of drift, and taking every book offline on
// a transport blip is a worse failure than quoting for another few minutes
// against limits that were correct when they were last read. Past the grace
// there is nothing left to stand on and the asset is refused.
const REFRESH_MS = 5 * 60_000
const GRACE_MS = 60 * 60_000

const cache = new Map<string, LimitsReconciliation>()

/** Drop every cached verdict. For tests and for the admin's forced re-read. */
export function resetLimitsCache(): void {
  cache.clear()
  pauseCache.clear()
}

/**
 * Reconcile one asset against its instance. Cached per vault id, so pointing
 * the environment at a different instance re-reads rather than inheriting the
 * old one's verdict.
 */
export async function reconcileLimits(
  asset: UnderlyingAsset,
  now: number = Date.now(),
): Promise<LimitsReconciliation> {
  const vault = asset.contracts.vault
  if (!vault) {
    return {
      symbol: asset.symbol,
      vault: '',
      ok: false,
      drift: [],
      onchain: null,
      checkedAt: now,
      error: 'no vault instance configured',
    }
  }

  const cached = cache.get(vault)
  if (cached && now - cached.checkedAt < REFRESH_MS) return cached

  try {
    const onchain = await getVaultLimits(asset)
    const drift = compareLimits(asset, onchain)
    const fresh: LimitsReconciliation = {
      symbol: asset.symbol,
      vault,
      ok: drift.length === 0,
      drift,
      onchain,
      checkedAt: now,
    }
    cache.set(vault, fresh)
    return fresh
  } catch (e: any) {
    const error = e?.message ?? 'limits unreadable'
    if (cached && now - cached.checkedAt < GRACE_MS) {
      return { ...cached, stale: true, error }
    }
    return {
      symbol: asset.symbol,
      vault,
      ok: false,
      drift: cached?.drift ?? [],
      onchain: null,
      checkedAt: now,
      error,
    }
  }
}

/**
 * The reason this asset must not be quoted, or null when there is none.
 *
 * Callers on the money path use this rather than the reconciliation itself, so
 * every refusal is worded the same way wherever it is raised.
 */
export async function limitsRefusal(
  asset: UnderlyingAsset,
  now: number = Date.now(),
): Promise<string | null> {
  const r = await reconcileLimits(asset, now)
  if (r.ok) return null
  if (r.drift.length > 0) {
    return `${asset.symbol} limits disagree with its vault: ${r.drift
      .map((d) => d.detail)
      .join('; ')}`
  }
  return `${asset.symbol} limits could not be read from its vault: ${r.error ?? 'unknown'}`
}

/** Every settleable book's verdict, for the health endpoint and the admin. */
export async function reconcileAll(
  now: number = Date.now(),
): Promise<LimitsReconciliation[]> {
  const books = allUnderlyings().filter((a) => a.contracts.vault)
  return Promise.all(books.map((a) => reconcileLimits(a, now)))
}

// ── The guardian's pause ────────────────────────────────────────────
//
// A paused v6 instance refuses every `open` (#24) and keeps settling. The
// contract is what binds, so this is not a second lock; it is the desk not
// signing quotes the contract will throw away, and the screens saying why
// rather than letting a writer sign and fail on chain.
//
// Read apart from the limits and on a much shorter clock. Limits move on a
// one-day delay and a reading five minutes old is as good as a new one; a
// pause is the emergency stop, and the desk should be quiet within a poll of
// it. A failed read falls back to the last one inside the same grace as the
// limits, for the same reason: an RPC blip is not a pause.

const PAUSE_REFRESH_MS = 30_000

export interface PauseReading {
  /** Null when the state could not be read and no reading stands. */
  paused: boolean | null
  checkedAt: number
  stale?: boolean
  error?: string
}

const pauseCache = new Map<string, { paused: boolean; checkedAt: number }>()

export async function readPause(
  asset: UnderlyingAsset,
  now: number = Date.now(),
): Promise<PauseReading> {
  const vault = asset.contracts.vault
  if (!vault) return { paused: null, checkedAt: now, error: 'no vault instance configured' }

  const cached = pauseCache.get(vault)
  if (cached && now - cached.checkedAt < PAUSE_REFRESH_MS) return cached

  try {
    const fresh = { paused: await getVaultPaused(asset), checkedAt: now }
    pauseCache.set(vault, fresh)
    return fresh
  } catch (e: any) {
    const error = e?.message ?? 'pause state unreadable'
    if (cached && now - cached.checkedAt < GRACE_MS) return { ...cached, stale: true, error }
    return { paused: null, checkedAt: now, error }
  }
}

/** Why this book is closed to new positions by its guardian, or null. */
export async function pauseRefusal(
  asset: UnderlyingAsset,
  now: number = Date.now(),
): Promise<string | null> {
  const r = await readPause(asset, now)
  if (r.paused === false) return null
  if (r.paused === true) {
    return `${asset.symbol} book is paused by its guardian: no new positions until the admin restarts it; open positions still settle`
  }
  return `${asset.symbol} pause state could not be read from its vault: ${r.error ?? 'unknown'}`
}
