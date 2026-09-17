// What an underlying is declared as, and how a declaration becomes an asset.
// =========================================================================
// Tranche 1 had one underlying, so the registry could be written by hand and
// nobody paid for it. Two made the cost visible; the framework milestone is
// about the third, which has to arrive without a code change.
//
// Two things stopped that. `UnderlyingSymbol` was a closed union, so listing
// an asset meant editing a type before writing any config. And the registry
// was a literal that read `process.env` inline at module load, which put the
// env keys, their fallbacks and the coercion rules in the same expression as
// the value — invisible to anything that wanted to check them, and copied by
// hand for each new asset.
//
// So the declaration is data. A field is either a literal or `{ env, fallback }`,
// and this file is the only place that knows how to turn one into the other:
// which keys are read, in what order, what an empty string means, and what
// makes a number unusable. `declare()` resolves a declaration into the flat
// `UnderlyingAsset` every rail already reads, so nothing downstream changes
// shape. Adding an asset is a new entry in config.ts and nothing else.
//
// The resolved asset is a snapshot taken at module load, exactly as before:
// the environment does not change under a running process, and a value that
// could change between two reads is not something the money path should be
// asking twice.

import { validateAsset, type ResolvedAsset } from './validate'

/**
 * A listed underlying's ticker. Open on purpose: an asset is listed by being
 * declared, not by being added to a union. The cost is that an unknown symbol
 * is now a runtime question rather than a compile-time one, which is why
 * `underlying()` throws and `resolveUnderlying()` returns null.
 */
export type UnderlyingSymbol = string

/** How the underlying's collateral leg is held on Stellar. */
export type StellarAsset =
  | { kind: 'native' }
  | { kind: 'issued'; code: string; issuer: string | null }

/** The three addresses this underlying's vault instance was constructed with. */
export interface UnderlyingContracts {
  vault: string
  /** SAC for the collateral a call escrows — the contract's `token`. */
  token: string
  /** SAC premiums are paid in and a put escrows — the contract's `cash`. */
  cash: string
}

/**
 * The risk limits the underlying's vault instance was deployed with, in the
 * collateral's own units: the underlying for a call, cash for a put.
 *
 * The contract's own copy is the one that binds. This is a second record of
 * it, kept beside the operating envelope below so the two can be compared
 * against the instance rather than assumed to agree. What it catches is a
 * `set_limits` nobody planned, or an instance deployed from numbers other
 * than these, either of which silently moves the bound the desk quotes
 * inside.
 */
export interface OnchainLimits {
  maxPositionCall: number
  maxPositionPut: number
  maxExpiryCall: number
  maxExpiryPut: number
  /** Premium ceiling in bps of escrowed collateral, the bound on a quoter. */
  maxPremiumBps: number
}

/**
 * Where the asset's strike ladder sits, in multiples of spot.
 *
 * Declared per asset because a ladder is a view on how far an underlying
 * travels in a week, and that is not the same question for a lumen and for a
 * bitcoin. The tick is a fraction of spot rather than an absolute step for the
 * same reason: an absolute one is either meaningless at $0.23 or meaningless
 * at $77,000.
 *
 * Read by lib/expiries and the pricing ladder from M2-03; until then the
 * numbers here mirror the globals in lib/pricing, which is why both assets
 * declare the same ones.
 */
export interface StrikeParams {
  /** Call rungs as a multiple of spot, nearest the money first. */
  callOtm: number[]
  /** Put rungs as a multiple of spot, nearest the money first. */
  putOtm: number[]
  /** Strike tick as a fraction of spot, before the 1-2-5 rounding. */
  tickFraction: number
}

/**
 * How many expiries the asset keeps open and how long each one runs.
 *
 * Declared per asset because the capacity split depends on it: a book's
 * monthly capacity is spread across `openExpiries` buckets, and that quotient
 * is the number reconciled against the contract's per-expiry cap.
 *
 * Read by lib/expiries from M2-04; until then these mirror its globals.
 */
export interface ExpiryParams {
  /** Rolling expiries open at once — the capacity divisor. */
  openExpiries: number
  /** Closest expiry the book will write, in days. */
  minDaysToExpiry: number
  /** Nominal gap between consecutive expiries, in days. */
  tenorDays: number
}

/**
 * One reason an asset cannot be served.
 *
 * `unconfigured` is a value this deployment has not supplied yet — expected on
 * a fresh environment, and fixed by filling in the env. `invalid` is a value
 * that is there and cannot be right, which is a bug somebody shipped. The
 * split matters because it decides whether a gated book is news.
 */
export interface AssetIssue {
  kind: 'unconfigured' | 'invalid'
  /** Dotted path into the declaration, e.g. `contracts.vault`. */
  field: string
  reason: string
}

export interface UnderlyingAsset {
  symbol: UnderlyingSymbol
  name: string
  /** URL segment, e.g. /earn/xlm. */
  slug: string
  icon: string
  /**
   * Whether the vault will quote and write this underlying. False means the
   * asset is declared but not servable; every entry point should check this
   * rather than assuming a listed asset is tradeable. Derived, not declared —
   * it is exactly `issues.length === 0`.
   */
  enabled: boolean
  /**
   * Every reason the asset is gated, empty when it is not. Carried on the
   * asset rather than thrown at load because one broken book must not take the
   * others down with it, and because "BTC is off" is a question somebody asks
   * at 3am — the answer belongs where they are already looking.
   */
  issues: AssetIssue[]
  contracts: UnderlyingContracts
  /** Reflector `Other(Symbol)` feed name — THE settlement price source. */
  feedSymbol: string
  /**
   * Binance ticker for the quote inputs and the spot fallback. Also names the
   * USDⓈ-M perp the forward reads its funding from; an asset without one falls
   * back to F = S rather than fabricating a carry.
   */
  binanceSymbol: string
  /** CoinGecko coin id — the second source for the realized-vol series. */
  coingeckoId: string
  /** The collateral a covered call escrows (the underlying itself). */
  stellarAsset: StellarAsset
  /** Decimals the amount is booked in. Stellar carries 7 for every asset. */
  unitDecimals: number
  /** Decimals worth showing — one BTC is not one XLM. */
  displayDecimals: number
  strike: StrikeParams
  expiry: ExpiryParams
  /** Smallest position the vault will write, in units of the underlying. */
  minSize: number
  /**
   * Largest single position, in units of the underlying, and the per-wallet
   * allowance for one expiry. Both mirror limits enforced elsewhere — the
   * first by the contract, the second by the quoter declining to sign — and
   * exist here so the screen can refuse before a wallet is opened rather than
   * after. Two records of one rule; keeping them equal is a job, not an
   * assumption.
   */
  maxSize: number
  userEpochCall: number
  /** The put leg's equivalents, in cash rather than in the underlying. */
  maxSizeCash: number
  userEpochPutUsd: number
  /** Covered-call capacity per month, in units of the underlying. */
  callMonthlyCap: number
  /** Cash-secured-put capacity per month, in USD. */
  putMonthlyCapUsd: number
  /**
   * What the deployed instance's `Limits` are supposed to be. Reconciled
   * against the instance itself before the asset is quoted, see
   * lib/vault-limits.
   */
  onchainLimits: OnchainLimits
}

/**
 * A field the environment supplies, with what to use when it does not.
 *
 * `env` takes a list where a key has been renamed: the first one set wins, so
 * XLM can keep naming `NEXT_PUBLIC_VAULT_CONTRACT` before `VAULT_CONTRACT`
 * without either spelling being special-cased in code.
 */
export interface FromEnv<T> {
  env: string | string[]
  fallback: T
}

export type DeclaredNumber = number | FromEnv<number>
export type DeclaredText = string | FromEnv<string>
export type DeclaredIssuer = string | null | FromEnv<string | null>

/** How the collateral leg is declared, before the environment is read. */
export type DeclaredCollateral =
  | { kind: 'native' }
  | { kind: 'issued'; code: DeclaredText; issuer: DeclaredIssuer }

/**
 * One underlying, as written in config.ts. Every field the milestone names is
 * here: the contracts it settles in, the oracle feed that prices it, the asset
 * it escrows, its strike and expiry parameters, and the position, capacity and
 * exposure bounds the desk quotes inside.
 */
export interface AssetDeclaration {
  symbol: string
  name: string
  slug: string
  icon: string
  contracts: {
    vault: DeclaredText
    token: DeclaredText
    cash: DeclaredText
  }
  feedSymbol: DeclaredText
  binanceSymbol: string
  coingeckoId: string
  collateral: DeclaredCollateral
  unitDecimals: number
  displayDecimals: number
  strike: StrikeParams
  expiry: ExpiryParams
  /** The bounds the desk quotes inside, all overridable per deployment. */
  envelope: {
    minSize: DeclaredNumber
    maxSize: DeclaredNumber
    userEpochCall: DeclaredNumber
    maxSizeCash: DeclaredNumber
    userEpochPutUsd: DeclaredNumber
    callMonthlyCap: DeclaredNumber
    putMonthlyCapUsd: DeclaredNumber
  }
  onchainLimits: OnchainLimits
}

/**
 * The `NEXT_PUBLIC_*` values, already substituted, for the bundle that runs in
 * a browser.
 *
 * This exists because of how those keys reach the client at all. There is no
 * `process.env` there; the bundler rewrites each literal `process.env.NEXT_PUBLIC_X`
 * it can see in the source into the value, and it can only see the ones
 * written out by name. A declaration names its keys as data — that is the
 * point of it — so `process.env[key]` is a lookup the bundler cannot rewrite,
 * and every public value would come back undefined in the browser while
 * working perfectly on the server. What that looks like is every asset gated
 * on the client and none on the server: a hydration mismatch, not an error.
 *
 * So config.ts writes the public keys out literally, once, and passes the
 * table through. Server-only keys are absent from it and read from
 * `process.env` as before, which is also what they did under the old registry:
 * a cap that is not `NEXT_PUBLIC_` has always fallen back to its default in
 * the browser.
 */
export type InlinedEnv = Record<string, string | undefined>

/**
 * First env key that carries something. Blank counts as unset: an env file
 * that names a key it has no value for is stating absence, and treating `''`
 * as a contract address would list an asset with nowhere to settle.
 */
function readEnv(keys: string | string[], inlined: InlinedEnv): string | undefined {
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    const raw = inlined[key] ?? process.env[key]
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  }
  return undefined
}

/**
 * Every environment key a declaration names, walked out of the declaration
 * itself so the list cannot fall behind it. What it is for: checking that the
 * public ones are all in the inlined table, which nothing else can check —
 * tests and `next build` both run where `process.env` is real.
 */
export function declaredEnvKeys(d: AssetDeclaration): string[] {
  const out = new Set<string>()
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if ('env' in record) {
      const named = record.env
      for (const key of Array.isArray(named) ? named : [named]) {
        if (typeof key === 'string') out.add(key)
      }
      return
    }
    for (const child of Object.values(record)) walk(child)
  }
  walk(d)
  return [...out]
}

/**
 * A cap or a size. Anything that is not a positive finite number falls back,
 * because a cap of zero, NaN or minus one is not a tighter limit — it is a
 * typo that would take the book offline or open it without a bound.
 */
export function resolveNumber(
  declared: DeclaredNumber,
  inlined: InlinedEnv = {}
): number {
  if (typeof declared === 'number') return declared
  const n = Number(readEnv(declared.env, inlined))
  return isFinite(n) && n > 0 ? n : declared.fallback
}

/** A contract id, a feed symbol, an asset code. */
export function resolveText(
  declared: DeclaredText,
  inlined: InlinedEnv = {}
): string {
  if (typeof declared === 'string') return declared
  return readEnv(declared.env, inlined) ?? declared.fallback
}

/** An issuer, where null is a real answer: nobody anchors this asset yet. */
export function resolveIssuer(
  declared: DeclaredIssuer,
  inlined: InlinedEnv = {}
): string | null {
  if (declared === null || typeof declared === 'string') return declared
  return readEnv(declared.env, inlined) ?? declared.fallback
}

/**
 * Resolve a declaration against the environment and check it, in that order:
 * the environment is where most of the holes are, so a declaration cannot be
 * judged before it is resolved.
 */
export function declare(
  d: AssetDeclaration,
  inlined: InlinedEnv = {}
): UnderlyingAsset {
  const text = (v: DeclaredText) => resolveText(v, inlined)
  const num = (v: DeclaredNumber) => resolveNumber(v, inlined)

  const stellarAsset: StellarAsset =
    d.collateral.kind === 'native'
      ? { kind: 'native' }
      : {
          kind: 'issued',
          code: text(d.collateral.code),
          issuer: resolveIssuer(d.collateral.issuer, inlined),
        }

  const resolved: ResolvedAsset = {
    symbol: d.symbol.trim().toUpperCase(),
    name: d.name,
    slug: d.slug,
    icon: d.icon,
    contracts: {
      vault: text(d.contracts.vault),
      token: text(d.contracts.token),
      cash: text(d.contracts.cash),
    },
    feedSymbol: text(d.feedSymbol),
    binanceSymbol: d.binanceSymbol,
    coingeckoId: d.coingeckoId,
    stellarAsset,
    unitDecimals: d.unitDecimals,
    displayDecimals: d.displayDecimals,
    strike: d.strike,
    expiry: d.expiry,
    minSize: num(d.envelope.minSize),
    maxSize: num(d.envelope.maxSize),
    userEpochCall: num(d.envelope.userEpochCall),
    maxSizeCash: num(d.envelope.maxSizeCash),
    userEpochPutUsd: num(d.envelope.userEpochPutUsd),
    callMonthlyCap: num(d.envelope.callMonthlyCap),
    putMonthlyCapUsd: num(d.envelope.putMonthlyCapUsd),
    onchainLimits: d.onchainLimits,
  }

  const issues = validateAsset(resolved)
  return { ...resolved, issues, enabled: issues.length === 0 }
}
