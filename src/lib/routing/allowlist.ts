// The routes the vault is allowed to take.
// =======================================
// A cash-secured put escrows ONE token — the `cash` address its instance was
// constructed with, which is LUSD on every book. That is fixed at init, so
// "escrow my USDC instead" is not something the contract can be asked for.
// What the writer means by it is answerable: the balance that leaves their
// wallet should be the stablecoin they picked. Crossing it is what routing is.
//
// Routing does it through Stellar's own liquidity, with a path payment
// (lib/routing/session composes the pieces; app/api/routing/swap serves it).
// The difference from the distributor's bridge, which is now the fallback, is
// that a path payment is atomic: it lands at or above the minimum output or it
// reverts having moved nothing. No float, no two-step, no money owed between.
//
// DECISION 2, settled: routing goes through **path payments over both
// sources**. Horizon's strict-receive path finder already traverses resting
// orderbook offers and AMM pools in one query, and `PathPaymentStrictReceive`
// enforces the output bound in the protocol rather than in our code. So the
// allowlist is not a choice of venue — it is the set of assets a route may
// touch, and a bound on how many of them one route may string together.
//
// THE RULE THIS FILE EXISTS FOR: anything not on the list is not a route. Not
// "is a worse route" — is not a route. That includes every intermediate hop a
// path finder proposes, because a path is only as trustworthy as the least
// trustworthy asset in it, and the path finder will happily route through a
// token somebody minted this morning if the price is good.

import { LUSD_CODE, LUSD_ISSUER } from '../lusd'
import { USDC_CODE, USDC_ISSUER } from '../usdc'

/** An asset a route may send, receive or pass through. Null issuer is native. */
export interface RoutedAsset {
  code: string
  issuer: string | null
}

export interface Route {
  /** Stable id, `send->receive` lower-cased. What logs and metrics key on. */
  id: string
  send: RoutedAsset
  receive: RoutedAsset
  /**
   * Intermediate assets one path may string together. Zero means the two ends
   * must trade directly against each other.
   *
   * Bounded because a path payment's cost and its failure modes both grow with
   * length, and because every extra hop is another asset whose liquidity can be
   * moved by somebody who noticed we route through it.
   */
  maxHops: number
  /**
   * How far below the quote execution may land, in basis points. Applied to the
   * quote to derive the send maximum — never supplied by a caller.
   */
  maxSlippageBps: number
  /** How long a quote stays usable. Past this it is a number, not a price. */
  quoteMaxAgeMs: number
  /** Ceiling on one swap, in units of the receive asset. */
  maxNotional: number
  /**
   * How far the quoted price may sit from one for one, in basis points. Set
   * only on a route between two assets that should trade at par; absent means
   * the route has no par to hold it to.
   *
   * The slippage allowance cannot do this job. It is measured from the quote,
   * so a book whose only offer prices LUSD at three USDC quotes three and fills
   * three with zero slippage. What protects the writer from that is a bound on
   * the price itself.
   */
  maxParDeviationBps?: number
}

const LUSD: RoutedAsset = { code: LUSD_CODE, issuer: LUSD_ISSUER }
const USDC: RoutedAsset = { code: USDC_CODE, issuer: USDC_ISSUER }

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return isFinite(n) && n > 0 ? n : fallback
}

// One pair, both directions. Two stablecoins that should trade at par, which is
// what makes a slippage bound meaningful here: 50 bps off par is not market
// movement, it is a thin book, and a route that wide should fail rather than
// fill.
const MAX_SLIPPAGE_BPS = num(process.env.ROUTING_MAX_SLIPPAGE_BPS, 50)
const QUOTE_MAX_AGE_MS = num(process.env.ROUTING_QUOTE_MAX_AGE_MS, 30_000)
const MAX_NOTIONAL = num(process.env.ROUTING_MAX_NOTIONAL, 10_000)
// Both ends are dollars, so a quote more than 1% from par is not a price worth
// paying. Checked 2026-10-03: the only testnet path from USDC to LUSD runs
// through XLM and costs 3.37 USDC per LUSD.
const MAX_PAR_DEVIATION_BPS = num(process.env.ROUTING_MAX_PAR_DEVIATION_BPS, 100)
// Direct only, for now. Both ends are dollars; a path that needs an
// intermediate to cross two dollars is telling you the direct book is empty,
// and the right answer to that is to not trade rather than to go around.
const MAX_HOPS = Math.max(0, Math.floor(num(process.env.ROUTING_MAX_HOPS, 0)))

const ROUTES: Route[] = [
  {
    id: 'usdc->lusd',
    send: USDC,
    receive: LUSD,
    maxHops: MAX_HOPS,
    maxSlippageBps: MAX_SLIPPAGE_BPS,
    quoteMaxAgeMs: QUOTE_MAX_AGE_MS,
    maxNotional: MAX_NOTIONAL,
    maxParDeviationBps: MAX_PAR_DEVIATION_BPS,
  },
  {
    id: 'lusd->usdc',
    send: LUSD,
    receive: USDC,
    maxHops: MAX_HOPS,
    maxSlippageBps: MAX_SLIPPAGE_BPS,
    quoteMaxAgeMs: QUOTE_MAX_AGE_MS,
    maxNotional: MAX_NOTIONAL,
    maxParDeviationBps: MAX_PAR_DEVIATION_BPS,
  },
]

/** Code AND issuer. An asset code is not an identity — anyone can issue a USDC. */
export function sameAsset(a: RoutedAsset, b: RoutedAsset): boolean {
  return a.code === b.code && (a.issuer ?? null) === (b.issuer ?? null)
}

export function routes(): Route[] {
  return ROUTES
}

/** The route between two assets, or null — which means "not a route". */
export function routeFor(send: RoutedAsset, receive: RoutedAsset): Route | null {
  return (
    ROUTES.find((r) => sameAsset(r.send, send) && sameAsset(r.receive, receive)) ?? null
  )
}

export function routeById(id: string): Route | null {
  return ROUTES.find((r) => r.id === id) ?? null
}

/**
 * Every asset any route may touch — the two ends of every declared route.
 *
 * This is what an intermediate hop is checked against. A path finder returns
 * whatever fills cheapest, and "cheapest" over a token with two offers in it is
 * a quote that evaporates between being read and being sent, or worse, a token
 * whose issuer can freeze the balance mid-path.
 */
export function allowedAssets(): RoutedAsset[] {
  const out: RoutedAsset[] = []
  for (const r of ROUTES) {
    for (const a of [r.send, r.receive]) {
      if (!out.some((seen) => sameAsset(seen, a))) out.push(a)
    }
  }
  return out
}

export function isAllowedAsset(a: RoutedAsset): boolean {
  return allowedAssets().some((allowed) => sameAsset(allowed, a))
}

/** Why a proposed path is not one this route may take. Null means it may. */
export function pathRefusal(route: Route, hops: RoutedAsset[]): string | null {
  if (hops.length > route.maxHops) {
    return route.maxHops === 0
      ? `${route.id} is direct only, and this path goes through ${hops.length} other asset(s)`
      : `${route.id} allows ${route.maxHops} intermediate asset(s), this path has ${hops.length}`
  }
  for (const hop of hops) {
    if (!isAllowedAsset(hop)) {
      return `${route.id} would pass through ${hop.code}, which is not on the allowlist`
    }
  }
  return null
}
