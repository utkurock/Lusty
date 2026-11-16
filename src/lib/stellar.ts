// The Stellar network this deployment runs on, and everything that follows
// from it: the passphrase every transaction is signed for, the RPC and
// Horizon endpoints, and the explorer links the UI hands out.
//
// One variable, NEXT_PUBLIC_STELLAR_NETWORK, decides it. Nothing else in the
// app names a passphrase or a testnet URL, so a public-network deployment
// cannot end up signing for one network while reading another. A value this
// module does not know is a configuration error and stops the app at load,
// rather than quietly falling back to testnet.
//
// The generic invoke/read helpers that used to live here are gone. Contract
// access goes through lib/vault-contract, which knows the vault's own encoding.

import { resolveNetwork } from './network.mjs'

export { resolveNetwork }
export type { StellarNetwork, StellarNetworkName } from './network.mjs'

// Each variable is read by its literal name: Next inlines NEXT_PUBLIC_ values
// into the browser bundle only where they are written out in full. That is
// also why the public network's RPC must be named in NEXT_PUBLIC_RPC_URL: the
// browser never sees SOROBAN_RPC_URL, so a deployment that set only that would
// start on the server and fail in every browser.
export const NETWORK = resolveNetwork({
  network: process.env.NEXT_PUBLIC_STELLAR_NETWORK,
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL,
  serverRpcUrl: process.env.SOROBAN_RPC_URL,
  horizonUrl: process.env.NEXT_PUBLIC_HORIZON_URL,
})

export const IS_TESTNET = NETWORK.name === 'testnet'
export const NETWORK_PASSPHRASE = NETWORK.passphrase
export const RPC_URL = NETWORK.rpcUrl
export const HORIZON_URL = NETWORK.horizonUrl
/** Circle's USDC on this network, by code and issuer. */
export const CIRCLE_USDC = NETWORK.usdc

export const explorerTxUrl = (hash: string) => `${NETWORK.explorerBase}/tx/${hash}`
export const explorerAccountUrl = (address: string) =>
  `${NETWORK.explorerBase}/account/${address}`
export const explorerContractUrl = (id: string) =>
  `${NETWORK.explorerBase}/contract/${id}`
