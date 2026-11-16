// Single source of truth for the LUSD asset, shared by client and server so
// the address the wallet pays always matches what the server verifies. The
// trim() + shared fallback keep them in sync even if NEXT_PUBLIC_* is missing
// or dirty (it's inlined at build, so a stale build can otherwise desync them).
// Blank counts as unset, as it does for the asset declarations: an env file
// naming a key it has no value for is stating absence, not an empty code.
const fromEnv = (v: string | undefined, fallback: string): string =>
  v?.trim() || fallback

export const LUSD_CODE = fromEnv(process.env.NEXT_PUBLIC_LUSD_CODE, 'LUSD')
export const LUSD_ISSUER = fromEnv(
  process.env.NEXT_PUBLIC_LUSD_ISSUER,
  'GBCMRD6NDL2RAJUOFQ25EHZVO3IRIGNESWE4QDRFB4AVFIP7IT5BRCJ6'
)
export const LUSD_DISTRIBUTOR = fromEnv(
  process.env.NEXT_PUBLIC_LUSD_DISTRIBUTOR,
  'GBAIN6CHZJGBL365JNXSRQEKALXYTWKXANQZ3RBM7AGUEYYKLJJ6SNR6'
)
