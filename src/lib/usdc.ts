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
const fromEnv = (v: string | undefined, fallback: string): string =>
  (v ?? fallback).trim()

export const USDC_CODE = fromEnv(process.env.NEXT_PUBLIC_USDC_CODE, 'USDC')
export const USDC_ISSUER = fromEnv(
  process.env.NEXT_PUBLIC_USDC_ISSUER,
  'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
)
