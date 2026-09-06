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
  /** Binance ticker for the quote inputs and the spot fallback. */
  binanceSymbol: string
  /** The collateral a covered call escrows (the underlying itself). */
  stellarAsset: StellarAsset
  /** Decimals the amount is booked in. Stellar carries 7 for every asset. */
  unitDecimals: number
  /** Decimals worth showing — one BTC is not one XLM. */
  displayDecimals: number
  /** Smallest position the vault will write, in units of the underlying. */
  minSize: number
  /** Covered-call capacity per month, in units of the underlying. */
  callMonthlyCap: number
  /** Cash-secured-put capacity per month, in USD. */
  putMonthlyCapUsd: number
}

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return isFinite(n) && n > 0 ? n : fallback
}

function contractId(raw: string | undefined): string {
  return (raw ?? '').trim()
}

// The anchor that issues the wrapped BTC the vault accepts as collateral.
// Unset on testnet until an anchor is chosen; see docs/ARCHITECTURE.md.
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
    stellarAsset: { kind: 'native' },
    unitDecimals: 7,
    displayDecimals: 2,
    minSize: num(process.env.VAULT_MIN_SIZE_XLM, 100),
    callMonthlyCap: num(process.env.VAULT_CALL_MONTHLY_CAP_XLM, 1_500_000),
    putMonthlyCapUsd: num(process.env.VAULT_PUT_MONTHLY_CAP_USD, 150_000),
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
    stellarAsset: { kind: 'issued', code: BTC_CODE, issuer: BTC_ISSUER },
    unitDecimals: 7,
    displayDecimals: 6,
    minSize: num(process.env.VAULT_MIN_SIZE_BTC, 0.001),
    // BTC keeps its own books: its capacity is not a share of XLM's, and
    // filling one leaves the other untouched.
    callMonthlyCap: num(process.env.VAULT_CALL_MONTHLY_CAP_BTC, 5),
    putMonthlyCapUsd: num(process.env.VAULT_PUT_MONTHLY_CAP_USD_BTC, 150_000),
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
