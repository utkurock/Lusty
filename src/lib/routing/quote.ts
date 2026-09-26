// Quoting a route before committing to it.
// =======================================
// Strict-RECEIVE, not strict-send. The writer needs an exact amount of cash to
// escrow — the position is sized in it — so the fixed side is the output and
// the question is what it costs. Strict-send answers a different question and
// would leave the escrow short by whatever the book moved.
//
// Horizon's path finder traverses resting offers and AMM pools together, which
// is what decision 2 bought: one query, both sources, and no venue to pick.
// What it does NOT do is care whose assets it routes through. That is this
// module's job, and it is why a path is refused rather than scored.
//
// A quote is a reading, and readings go off. Every one carries the instant it
// was taken so whatever spends it can ask how old it is, rather than trusting
// that not much happens in a few seconds. On a two-offer book, a few seconds is
// the whole story.

import { Asset, Horizon } from '@stellar/stellar-sdk'
import { HORIZON_URL } from '../stellar'
import { pathRefusal, sameAsset, type Route, type RoutedAsset } from './allowlist'

/** Stellar carries seven decimals. More than that is not representable. */
const DECIMALS = 7

export interface RouteQuote {
  route: Route
  /** What the caller asked to receive, in the receive asset. */
  destAmount: number
  /** What the path finder says that costs, in the send asset. */
  sendAmount: number
  /** Intermediate assets the path goes through, in order. */
  hops: RoutedAsset[]
  /** When the reading was taken. `quoteAge` is measured from this. */
  quotedAt: number
}

export type RouteRefusalCode =
  | 'invalid_amount'
  | 'above_notional'
  | 'no_liquidity'
  | 'path_not_allowed'
  | 'unreachable'

export class RouteRefused extends Error {
  constructor(
    message: string,
    readonly code: RouteRefusalCode,
  ) {
    super(message)
    this.name = 'RouteRefused'
  }
}

/** The SDK's asset, from ours. */
export function toStellarAsset(a: RoutedAsset): Asset {
  return a.issuer === null ? Asset.native() : new Asset(a.code, a.issuer)
}

function assetFrom(
  type: string | undefined,
  code: string | undefined,
  issuer: string | undefined,
): RoutedAsset {
  return type === 'native'
    ? { code: 'XLM', issuer: null }
    : { code: code ?? '', issuer: issuer ?? null }
}

/** How long ago a quote was taken. Split out so the bound is testable. */
export function quoteAge(quote: RouteQuote, now: number = Date.now()): number {
  return now - quote.quotedAt
}

export function isStale(quote: RouteQuote, now: number = Date.now()): boolean {
  return quoteAge(quote, now) > quote.route.quoteMaxAgeMs
}

/**
 * Pick the path this route may take out of what the finder returned.
 *
 * Pure, and separate from the fetch, because it is the half that decides
 * anything: which paths are refused, why, and which one is taken when several
 * are allowed. A network call wrapped around it would make that untestable
 * without pretending to be Horizon.
 *
 * Cheapest first, then the first one the allowlist accepts — not "the cheapest
 * allowed" by a sort of our own. The finder already returns these in cost
 * order, and re-ranking on our arithmetic over its numbers is a second opinion
 * about a market we are not the authority on.
 */
export function choosePath(
  route: Route,
  records: Horizon.ServerApi.PaymentPathRecord[],
): { sendAmount: number; hops: RoutedAsset[] } {
  if (records.length === 0) {
    throw new RouteRefused(`${route.id}: nothing on the ledger fills this right now`, 'no_liquidity')
  }

  const sorted = [...records].sort(
    (a, b) => Number(a.source_amount) - Number(b.source_amount),
  )

  let lastRefusal: string | null = null
  for (const record of sorted) {
    const send = assetFrom(
      record.source_asset_type,
      record.source_asset_code,
      record.source_asset_issuer,
    )
    const receive = assetFrom(
      record.destination_asset_type,
      record.destination_asset_code,
      record.destination_asset_issuer,
    )
    // Trust nothing about the ends either. A finder answering about a different
    // pair than it was asked about is not something to accommodate.
    if (!sameAsset(send, route.send) || !sameAsset(receive, route.receive)) {
      lastRefusal = `${route.id}: the path finder answered about a different pair`
      continue
    }

    const hops = (record.path ?? []).map((p) =>
      assetFrom(p.asset_type, p.asset_code, p.asset_issuer),
    )
    const refusal = pathRefusal(route, hops)
    if (refusal) {
      lastRefusal = refusal
      continue
    }

    const sendAmount = Number(record.source_amount)
    if (!isFinite(sendAmount) || sendAmount <= 0) {
      lastRefusal = `${route.id}: the path finder quoted ${record.source_amount}`
      continue
    }
    return { sendAmount, hops }
  }

  throw new RouteRefused(
    lastRefusal ?? `${route.id}: no path the allowlist permits`,
    'path_not_allowed',
  )
}

/**
 * What it costs to receive exactly `destAmount` over this route.
 *
 * Refuses rather than returning a worse answer, on every count: an amount above
 * the route's notional ceiling, a path through an asset nobody allowlisted, a
 * path longer than the route permits, or no path at all. "No liquidity" is a
 * refusal and not an error — an empty book is a fact about the market, and the
 * caller's move is to not trade rather than to retry.
 *
 * The `sendAmount` here is the quote, not the bound. Turning it into a send
 * maximum is `lib/routing/execute`'s job, because that is where the slippage
 * allowance is applied and neither number should be assembled by a caller.
 */
export async function quoteRoute(
  route: Route,
  destAmount: number,
  now: number = Date.now(),
): Promise<RouteQuote> {
  if (!isFinite(destAmount) || destAmount <= 0) {
    throw new RouteRefused(`${route.id}: ${destAmount} is not an amount`, 'invalid_amount')
  }
  if (destAmount > route.maxNotional) {
    throw new RouteRefused(
      `${route.id}: ${destAmount} is above the ${route.maxNotional} ceiling for one swap`,
      'above_notional',
    )
  }

  let records: Horizon.ServerApi.PaymentPathRecord[]
  try {
    const res = await new Horizon.Server(HORIZON_URL)
      .strictReceivePaths(
        [toStellarAsset(route.send)],
        toStellarAsset(route.receive),
        destAmount.toFixed(DECIMALS),
      )
      .call()
    records = res.records
  } catch (err: any) {
    // An unreachable path finder is not an empty book, and a caller that
    // conflated the two would read an outage as a market condition.
    throw new RouteRefused(
      `${route.id}: the path finder did not answer — ${err?.message ?? 'unknown'}`,
      'unreachable',
    )
  }

  const { sendAmount, hops } = choosePath(route, records ?? [])
  return { route, destAmount, sendAmount, hops, quotedAt: now }
}
