// Network endpoints, shared by the classic-payment and Soroban paths.
//
// The generic invoke/read helpers that used to live here are gone. Contract
// access now goes through lib/vault-contract, which knows the vault's own
// encoding — its scales, its Kind discriminant, and the quoter co-signature
// its writes require — rather than passing raw ScVals around.

import { Networks } from '@stellar/stellar-sdk'

export const NETWORK_PASSPHRASE = Networks.TESTNET
export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? 'https://soroban-testnet.stellar.org'
export const HORIZON_URL =
  process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org'

export const CONTRACTS = {
  /** The vault. One instance serves both covered calls and cash-secured puts. */
  VAULT: process.env.NEXT_PUBLIC_VAULT_CONTRACT ?? '',
  USDC:
    process.env.NEXT_PUBLIC_USDC_CONTRACT ??
    'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  XLM: 'native',
}
