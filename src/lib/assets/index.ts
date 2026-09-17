// The underlying-asset registry.
// ==============================
// Until Tranche 2 "the underlying" was XLM everywhere, spelled out inline: the
// Reflector feed symbol lived in reflector.ts, the Binance ticker in spot.ts,
// the caps in vault-state.ts, and the display list in contracts.ts. Adding a
// second underlying that way means finding every one of those spellings and
// hoping none was missed — and a missed one is not a cosmetic bug, it is a
// BTC position priced or capped off XLM's numbers.
//
// So each underlying is declared once, in config.ts, with everything that is
// specific to it: which feed prices it, how it is held on Stellar, which
// contracts hold its book, where its strikes and expiries sit, and its own cap
// envelope. schema.ts turns a declaration into an asset. This file is only the
// lookups the rails use, and it is the module every caller imports.
//
// Each underlying settles in its own vault instance — a second deployment of
// the same parameterised contract, which is what keeps the escrow, exposure
// and limits of one asset out of another's. An asset stays gated until
// everything it needs to settle is named.

import { DECLARATIONS } from './config'
import { declare, type UnderlyingAsset, type UnderlyingSymbol } from './schema'

export type {
  AssetDeclaration,
  ExpiryParams,
  OnchainLimits,
  StellarAsset,
  StrikeParams,
  UnderlyingAsset,
  UnderlyingContracts,
  UnderlyingSymbol,
} from './schema'

// A Map rather than an object, because symbols now come from untrusted input
// and an object answers for keys nobody declared: `REGISTRY['constructor']` is
// a function, not an asset, and every lookup below would have to say so.
const REGISTRY: Map<string, UnderlyingAsset> = new Map(
  DECLARATIONS.map((d) => {
    const asset = declare(d)
    return [asset.symbol, asset] as const
  })
)

function lookup(raw: unknown): UnderlyingAsset | null {
  if (typeof raw !== 'string') return null
  return REGISTRY.get(raw.trim().toUpperCase()) ?? null
}

/** Registry lookup by exact symbol. Throws — a bad symbol is a bug, not input. */
export function underlying(symbol: UnderlyingSymbol): UnderlyingAsset {
  const found = REGISTRY.get(symbol)
  if (!found) throw new Error(`underlying: ${symbol} is not declared`)
  return found
}

// The two books that exist today, named so callers that genuinely mean "XLM"
// do not spell it as a lookup. Throws at load if either stops being declared,
// which is the right time to find out: XLM in particular is what a request
// naming no asset resolves to.
export const XLM = underlying('XLM')
export const BTC = underlying('BTC')

/** Every declared underlying, tradeable or not. Admin and docs surfaces. */
export function allUnderlyings(): UnderlyingAsset[] {
  return [...REGISTRY.values()]
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
  return lookup(symbol)?.displayDecimals ?? fallback
}

/**
 * Resolve untrusted input (a route param, a query string, a DB column) to an
 * underlying. Returns null for anything unknown or not yet enabled, so a
 * caller cannot accidentally quote a gated asset by typing its name into a URL.
 */
export function resolveUnderlying(raw: unknown): UnderlyingAsset | null {
  const found = lookup(raw)
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
  const found = lookup(raw)
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
