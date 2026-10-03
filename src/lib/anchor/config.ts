/**
 * The USDC the bridge accepts, pinned.
 *
 * The TRY ramp that used to sit beside this is gone; what is left is the asset
 * the bridge in app/api/anchor/bridge swaps one for one with LUSD. It spends
 * the distributor's balances, so the code and issuer are named here rather
 * than discovered from anyone's stellar.toml: a payout route that decided
 * which asset it accepts by reading a file on someone else's server would
 * accept whatever that file said tomorrow.
 */

export const ANCHOR_ASSET_CODE =
  process.env.NEXT_PUBLIC_ANCHOR_ASSET_CODE ?? 'USDC'

export const ANCHOR_ASSET_ISSUER =
  process.env.NEXT_PUBLIC_ANCHOR_ASSET_ISSUER ??
  'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

/** The smallest bridge crossing worth a transaction fee, in either asset. */
export const BRIDGE_MIN_AMOUNT = 1
