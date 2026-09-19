/**
 * The anchor section's whole configuration.
 *
 * A SEP integration's handoff is two values: a home domain and an asset code.
 * Everything else — where to authenticate, where to deposit, which issuer the
 * asset has — is discovered from the domain's stellar.toml at runtime, which is
 * why nothing below names an endpoint. Pointing this at a real Turkish anchor
 * on mainnet is a change to these two constants and the network, nothing more.
 *
 * This directory is deliberately self-contained: it reads the shared network
 * endpoints and nothing else of Lusty's. The vault, the quote engine and the
 * database do not know it exists, and it does not know they do.
 */

export const ANCHOR_HOME_DOMAIN =
  process.env.NEXT_PUBLIC_ANCHOR_HOME_DOMAIN ?? 'tr-mock-anchor.fly.dev'

export const ANCHOR_ASSET_CODE =
  process.env.NEXT_PUBLIC_ANCHOR_ASSET_CODE ?? 'USDC'

/**
 * The issuer the bridge will pay out against, pinned.
 *
 * Everywhere else in this section the issuer is discovered from stellar.toml,
 * because that is what makes the ramp portable. The bridge is the exception: it
 * spends the distributor's balances, and a payout route that decides which
 * asset it accepts by reading a file on someone else's server accepts whatever
 * that file says tomorrow. So the asset is named here, and the convert screen
 * refuses to run if the anchor is advertising a different one.
 */
export const ANCHOR_ASSET_ISSUER =
  process.env.NEXT_PUBLIC_ANCHOR_ASSET_ISSUER ??
  'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

/** The smallest bridge crossing worth a transaction fee, in either asset. */
export const BRIDGE_MIN_AMOUNT = 1

/** The off-chain side of the pair, as SEP-38 names it (ISO 4217). */
export const FIAT_CODE = 'TRY'
export const FIAT_ASSET = `iso4217:${FIAT_CODE}`

/** How the fiat leg moves. The anchor offers one method and names it this. */
export const DELIVERY_METHOD = 'bank_account'

/** SEP-38 quotes are scoped to the SEP they will be spent in. */
export const QUOTE_CONTEXT = 'sep6'

/** Poll cadence for a transaction that is waiting on the anchor, in ms. */
export const POLL_INTERVAL_MS = 3000
