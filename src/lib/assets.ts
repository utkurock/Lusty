// The underlying-asset registry.
// ==============================
// Until now "the underlying" was XLM everywhere, spelled out inline: the
// Reflector feed symbol lived in reflector.ts, the Binance ticker in spot.ts,
// the caps in vault-state.ts, and the display list in contracts.ts. Adding a
// second underlying that way means finding every one of those spellings and
// hoping none was missed — and a missed one is not a cosmetic bug, it is a
// BTC position priced or capped off XLM's numbers.
//
// So each underlying is declared once, here, with everything that is specific
// to it: which feed prices it, how it is held on Stellar, which contracts hold
// its book, and its own cap envelope. The rails read the registry instead of a
// constant.
//
// Each underlying settles in its own vault instance — a second deployment of
// the same parameterised contract, which is what keeps the escrow, exposure
// and limits of one asset out of another's. An asset stays gated until
// everything it needs to settle is named.

export type UnderlyingSymbol = 'XLM' | 'BTC'

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

export interface UnderlyingAsset {
  symbol: UnderlyingSymbol
  name: string
  /** URL segment, e.g. /earn/xlm. */
  slug: string
  icon: string
  /**
   * Whether the vault will quote and write this underlying. False means the
   * asset is declared but not yet wired end to end; every entry point should
   * check this rather than assuming a listed asset is tradeable. Derived, not
   * declared — see `tradeable()`.
   */
  enabled: boolean
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

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return isFinite(n) && n > 0 ? n : fallback
}

function contractId(raw: string | undefined): string {
  return (raw ?? '').trim()
}

// The anchor that issues the wrapped BTC the vault accepts as collateral.
// On testnet that is LBTC, issued by this repo (scripts/mint-lbtc.mjs) for the
// same reason LUSD is: nobody anchors wrapped BTC to a network whose BTC has no
// reserve behind it. Settlement is unaffected — the price comes from the
// Reflector BTC/USD feed, never from the issuer. Mainnet replaces this key with
// a real anchor's, and nothing else changes.
const BTC_ISSUER = process.env.NEXT_PUBLIC_BTC_ANCHOR_ISSUER || null
const BTC_CODE = process.env.NEXT_PUBLIC_BTC_ANCHOR_CODE || 'BTC'

// Named per asset, though every underlying settles in the same cash today, so
// an asset settling in something else stays a config change.
const LUSD_SAC = contractId(
  process.env.NEXT_PUBLIC_LUSD_CONTRACT ??
    'CDTMNV7F7P3LUH6LLBTXY4EQYBUYGVGYRC7P73HMFV5PXLO5NE6A74QB'
)

/**
 * Tradeable when nothing it needs to settle is missing: an issuer for the
 * collateral it escrows, and all three contracts. Half-configured is gated —
 * the failure that matters is a position written somewhere it cannot settle.
 */
function tradeable(a: Omit<UnderlyingAsset, 'enabled'>): boolean {
  if (a.stellarAsset.kind === 'issued' && !a.stellarAsset.issuer) return false
  const { vault, token, cash } = a.contracts
  return Boolean(vault && token && cash)
}

function declare(a: Omit<UnderlyingAsset, 'enabled'>): UnderlyingAsset {
  return { ...a, enabled: tradeable(a) }
}

const REGISTRY: Record<UnderlyingSymbol, UnderlyingAsset> = {
  XLM: declare({
    symbol: 'XLM',
    name: 'Stellar Lumens',
    slug: 'xlm',
    icon: '✦',
    contracts: {
      // Keeps its Tranche 1 spelling: it named the only instance there was.
      vault: contractId(
        process.env.NEXT_PUBLIC_VAULT_CONTRACT ?? process.env.VAULT_CONTRACT
      ),
      token: contractId(
        process.env.NEXT_PUBLIC_XLM_CONTRACT ??
          'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
      ),
      cash: LUSD_SAC,
    },
    feedSymbol: process.env.REFLECTOR_FEED_SYMBOL ?? 'XLM',
    binanceSymbol: 'XLMUSDT',
    coingeckoId: 'stellar',
    stellarAsset: { kind: 'native' },
    unitDecimals: 7,
    displayDecimals: 2,
    minSize: num(process.env.VAULT_MIN_SIZE_XLM, 100),
    maxSize: num(process.env.VAULT_MAX_SIZE_XLM, 10_000),
    userEpochCall: num(process.env.MAX_USER_EPOCH_CALL_XLM, 10_000),
    maxSizeCash: num(process.env.VAULT_MAX_SIZE_CASH_XLM, 10_000),
    userEpochPutUsd: num(process.env.MAX_USER_EPOCH_PUT_USD, 10_000),
    callMonthlyCap: num(process.env.VAULT_CALL_MONTHLY_CAP_XLM, 1_500_000),
    putMonthlyCapUsd: num(process.env.VAULT_PUT_MONTHLY_CAP_USD, 150_000),
    // Read off CBJZGTCF…UCJZ on 2026-09-15. The expiry caps are ten times the
    // envelope's own per-expiry put bucket, which is deliberate: the contract
    // is the outer bound, the desk quotes inside it.
    onchainLimits: {
      maxPositionCall: 10_000,
      maxPositionPut: 10_000,
      maxExpiryCall: 500_000,
      maxExpiryPut: 500_000,
      maxPremiumBps: 2_000,
    },
  }),
  BTC: declare({
    symbol: 'BTC',
    name: 'Bitcoin',
    slug: 'btc',
    icon: '₿',
    // No default: falling back to XLM's would put BTC's money in XLM's vault.
    contracts: {
      vault: contractId(process.env.NEXT_PUBLIC_VAULT_CONTRACT_BTC),
      token: contractId(process.env.NEXT_PUBLIC_BTC_CONTRACT),
      cash: LUSD_SAC,
    },
    feedSymbol: process.env.REFLECTOR_FEED_SYMBOL_BTC ?? 'BTC',
    binanceSymbol: 'BTCUSDT',
    coingeckoId: 'bitcoin',
    stellarAsset: { kind: 'issued', code: BTC_CODE, issuer: BTC_ISSUER },
    unitDecimals: 7,
    displayDecimals: 6,
    minSize: num(process.env.VAULT_MIN_SIZE_BTC, 0.001),
    // The deployed instance's own limits: 0.05 BTC a call position, 1,500 cash
    // a put position. XLM's 10,000 would read as 10,000 BTC.
    maxSize: num(process.env.VAULT_MAX_SIZE_BTC, 0.05),
    userEpochCall: num(process.env.MAX_USER_EPOCH_CALL_BTC, 0.05),
    maxSizeCash: num(process.env.VAULT_MAX_SIZE_CASH_BTC, 1_500),
    userEpochPutUsd: num(process.env.MAX_USER_EPOCH_PUT_USD_BTC, 1_500),
    // BTC keeps its own books: its capacity is not a share of XLM's, and
    // filling one leaves the other untouched.
    callMonthlyCap: num(process.env.VAULT_CALL_MONTHLY_CAP_BTC, 5),
    putMonthlyCapUsd: num(process.env.VAULT_PUT_MONTHLY_CAP_USD_BTC, 150_000),
    // Read off CBQEACXA…MVEU on 2026-09-15, the values scripts/deploy-vault.mjs
    // constructed it with.
    onchainLimits: {
      maxPositionCall: 0.05,
      maxPositionPut: 1_500,
      maxExpiryCall: 5,
      maxExpiryPut: 150_000,
      maxPremiumBps: 2_000,
    },
  }),
}

export const XLM = REGISTRY.XLM
export const BTC = REGISTRY.BTC

/** Every declared underlying, tradeable or not. Admin and docs surfaces. */
export function allUnderlyings(): UnderlyingAsset[] {
  return Object.values(REGISTRY)
}

/** The underlyings a user can actually write against right now. */
export function enabledUnderlyings(): UnderlyingAsset[] {
  return allUnderlyings().filter((a) => a.enabled)
}

/**
 * Every deployed vault instance, deduplicated — the set the event indexer
 * streams. Declaring an asset with a vault is what puts it in the feed.
 */
export function vaultInstances(): string[] {
  const ids = allUnderlyings()
    .map((a) => a.contracts.vault)
    .filter(Boolean)
  return [...new Set(ids)]
}

/**
 * The underlying whose vault this contract id is.
 *
 * The reverse of `contracts.vault`, and the only way a read that starts from a
 * chain event can name the book it belongs to: an event carries the contract
 * that emitted it, never the symbol. Null for an id the registry does not
 * know — a retired instance, or another deployment entirely — which callers
 * must treat as "not one of ours" rather than as XLM.
 */
export function underlyingByVault(contractId: unknown): UnderlyingAsset | null {
  if (typeof contractId !== 'string' || !contractId) return null
  return allUnderlyings().find((a) => a.contracts.vault === contractId) ?? null
}

/**
 * Decimals worth showing for a symbol that may not be an underlying at all.
 *
 * Position records carry the collateral's ticker, and on the put leg that is
 * cash rather than a book — so this answers for anything, and answers two for
 * what it does not know, which is what every caller used to hardcode.
 */
export function displayDecimalsOf(symbol: string, fallback = 2): number {
  const found = (REGISTRY as Record<string, UnderlyingAsset>)[
    String(symbol).trim().toUpperCase()
  ]
  return found ? found.displayDecimals : fallback
}

/** Registry lookup by exact symbol. Throws — a bad symbol is a bug, not input. */
export function underlying(symbol: UnderlyingSymbol): UnderlyingAsset {
  return REGISTRY[symbol]
}

/**
 * Resolve untrusted input (a route param, a query string, a DB column) to an
 * underlying. Returns null for anything unknown or not yet enabled, so a
 * caller cannot accidentally quote a gated asset by typing its name into a URL.
 */
export function resolveUnderlying(raw: unknown): UnderlyingAsset | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim().toUpperCase()
  const found = (REGISTRY as Record<string, UnderlyingAsset>)[key]
  return found && found.enabled ? found : null
}

/**
 * Every underlying with a vault to settle against — the books a settlement
 * sweep must walk. Wider than `enabledUnderlyings()` on purpose: see below.
 */
export function settleableUnderlyings(): UnderlyingAsset[] {
  return allUnderlyings().filter((a) => a.contracts.vault)
}

/**
 * The underlying an existing position belongs to, whether or not it is still
 * being written.
 *
 * Settlement has to outlive listing. An asset withdrawn from quoting still has
 * open positions, and `settle` is the only thing that releases their
 * collateral — gating the runner on `enabled` would strand it. So this asks
 * the one question settlement actually needs answered: is there an instance to
 * settle against.
 */
export function settleableUnderlying(raw: unknown): UnderlyingAsset | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim().toUpperCase()
  const found = (REGISTRY as Record<string, UnderlyingAsset>)[key]
  return found && found.contracts.vault ? found : null
}

/**
 * The underlying a request names. Absent means XLM — the only asset Tranche 1's
 * callers knew about, so an old client keeps working unchanged.
 *
 * Null for anything else, including a gated asset spelled correctly. The
 * failure this exists to prevent is a request naming BTC being served XLM: the
 * quote would price off the wrong market and the position would be written to
 * the wrong instance, both silently.
 */
export function requestedUnderlying(raw: unknown): UnderlyingAsset | null {
  if (raw === undefined || raw === null || raw === '') {
    return XLM.enabled ? XLM : null
  }
  return resolveUnderlying(raw)
}
