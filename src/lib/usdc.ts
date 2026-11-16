// The USDC the app means when it says USDC.
//
// Written down for the same reason LUSD is (see lib/lusd.ts): an asset code is
// not an identity. Anyone can issue something called USDC, and a screen that
// reads a balance by code alone will happily report a stranger's token as the
// user's cash. Code AND issuer, from one place, so every surface that shows,
// spends or checks it is talking about the same asset.
//
// This is the asset the anchor pays out — lib/anchor/config.ts pins the same
// issuer for the bridge, and `NEXT_PUBLIC_USDC_CONTRACT` is precisely this
// asset's SAC, so the classic line and the Soroban contract agree. The anchor
// section keeps its own copy on purpose: it is self-contained, and its constant
// is about what the bridge will accept, not about what the venue calls cash.
import { CIRCLE_USDC } from './stellar'
import { CASH } from './assets'

// Blank counts as unset, as it does for the asset declarations: an env file
// naming a key it has no value for is stating absence, not an empty code.
const fromEnv = (v: string | undefined, fallback: string): string =>
  v?.trim() || fallback

// Circle's, on whichever network this deployment is on.
export const USDC_CODE = fromEnv(process.env.NEXT_PUBLIC_USDC_CODE, CIRCLE_USDC.code)
export const USDC_ISSUER = fromEnv(process.env.NEXT_PUBLIC_USDC_ISSUER, CIRCLE_USDC.issuer)

/**
 * Whether USDC is something other than the cash a put escrows, and so has to
 * be routed into it before it can be. On the public network the cash is
 * Circle's USDC itself, and there is nothing to cross.
 */
export const USDC_ROUTES_TO_CASH = !(CASH.code === USDC_CODE && CASH.issuer === USDC_ISSUER)
