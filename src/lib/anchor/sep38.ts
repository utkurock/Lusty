/**
 * SEP-38: what the rate is, and holding it still while the user decides.
 *
 * Two calls with the same shape and different promises. `/price` is indicative
 * and costs nothing, so it is what the amount field quotes against as the user
 * types. `/quote` is firm: it returns an id and an expiry, and passing that id
 * to the deposit means the rate the user was shown is the rate they are paid,
 * rather than whatever the oracle says by the time the money lands.
 */

import { anchorFetch, anchorCurrency, loadAnchorToml, query, sep38Asset, AnchorError } from './client'
import { DELIVERY_METHOD, FIAT_ASSET, QUOTE_CONTEXT } from './config'
import type { AnchorPrice, AnchorQuote } from './types'

export type Direction = 'on' | 'off'

/** On-ramp sells TRY for the anchored asset; off-ramp sells the asset for TRY. */
async function legs(direction: Direction) {
  const currency = await anchorCurrency()
  const asset = sep38Asset(currency)
  return direction === 'on'
    ? { sell: FIAT_ASSET, buy: asset, sellDelivery: DELIVERY_METHOD, buyDelivery: undefined }
    : { sell: asset, buy: FIAT_ASSET, sellDelivery: undefined, buyDelivery: DELIVERY_METHOD }
}

async function quoteServer(): Promise<string> {
  const toml = await loadAnchorToml()
  if (!toml.quoteServer) throw new AnchorError('this anchor publishes no quote server', 0, 'stellar.toml')
  return toml.quoteServer
}

function toPrice(raw: any): AnchorPrice {
  return {
    totalPrice: raw.total_price,
    price: raw.price,
    sellAmount: raw.sell_amount,
    buyAmount: raw.buy_amount,
    fee: raw.fee,
  }
}

/** An indicative price for `sellAmount` of the sell side. */
export async function fetchPrice(
  direction: Direction,
  sellAmount: string,
  token: string
): Promise<AnchorPrice> {
  const { sell, buy, sellDelivery, buyDelivery } = await legs(direction)
  const url =
    `${await quoteServer()}/price` +
    query({
      sell_asset: sell,
      buy_asset: buy,
      sell_amount: sellAmount,
      context: QUOTE_CONTEXT,
      sell_delivery_method: sellDelivery,
      buy_delivery_method: buyDelivery,
    })
  return toPrice(await anchorFetch<any>(url, { token }))
}

/** A firm quote. Its id is what the SEP-6 exchange endpoints lock against. */
export async function fetchQuote(
  direction: Direction,
  sellAmount: string,
  token: string
): Promise<AnchorQuote> {
  const { sell, buy, sellDelivery, buyDelivery } = await legs(direction)
  const raw = await anchorFetch<any>(`${await quoteServer()}/quote`, {
    token,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sell_asset: sell,
      buy_asset: buy,
      sell_amount: sellAmount,
      context: QUOTE_CONTEXT,
      sell_delivery_method: sellDelivery,
      buy_delivery_method: buyDelivery,
    }),
  })
  return {
    ...toPrice(raw),
    id: raw.id,
    expiresAt: raw.expires_at,
    sellAsset: raw.sell_asset,
    buyAsset: raw.buy_asset,
  }
}

/**
 * The headline rate, without a session.
 *
 * `/prices` takes no token, which is what lets the landing screen show what
 * the anchor is paying before anyone has connected a wallet. It answers with
 * one entry per asset it would sell for the amount named; the price is TRY per
 * unit of the anchored asset, spread included.
 */
export async function fetchHeadlineRate(sellTry = '1000'): Promise<{ asset: string; price: string } | null> {
  const currency = await anchorCurrency()
  const asset = sep38Asset(currency)
  const raw = await anchorFetch<{ buy_assets?: { asset: string; price: string }[] }>(
    `${await quoteServer()}/prices` +
      query({ sell_asset: FIAT_ASSET, sell_amount: sellTry, sell_delivery_method: DELIVERY_METHOD })
  )
  const found = raw.buy_assets?.find(a => a.asset === asset) ?? raw.buy_assets?.[0]
  return found ?? null
}
