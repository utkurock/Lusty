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

import { Networks } from '@stellar/stellar-sdk'

export type StellarNetworkName = 'testnet' | 'public'

export interface StellarNetwork {
  name: StellarNetworkName
  passphrase: string
  rpcUrl: string
  horizonUrl: string
  /** stellar.expert's path segment for this network. */
  explorerBase: string
}

const DEFAULTS: Record<
  StellarNetworkName,
  { passphrase: string; rpcUrl?: string; horizonUrl: string }
> = {
  testnet: {
    passphrase: Networks.TESTNET,
    rpcUrl: 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
  },
  // SDF runs no public-network RPC, so there is no default to fall back on:
  // the provider is a deployment choice and has to be named.
  public: {
    passphrase: Networks.PUBLIC,
    horizonUrl: 'https://horizon.stellar.org',
  },
}

export interface NetworkEnv {
  network?: string
  /** NEXT_PUBLIC_RPC_URL — the RPC both the browser and the server see. */
  rpcUrl?: string
  /** SOROBAN_RPC_URL — a server-only override of it. */
  serverRpcUrl?: string
  horizonUrl?: string
}

/**
 * Resolves the network from its configuration. Unset means testnet, which is
 * what every deployment before the variable existed ran on; anything that is
 * neither name throws.
 */
export function resolveNetwork(env: NetworkEnv): StellarNetwork {
  const raw = (env.network ?? '').trim()
  const name = raw === '' ? 'testnet' : raw
  if (name !== 'testnet' && name !== 'public') {
    throw new Error(
      `NEXT_PUBLIC_STELLAR_NETWORK is "${raw}"; expected "testnet" or "public"`,
    )
  }
  const d = DEFAULTS[name]
  const sharedRpcUrl = env.rpcUrl?.trim() || d.rpcUrl
  if (!sharedRpcUrl) {
    throw new Error(
      `the ${name} network has no default RPC; set NEXT_PUBLIC_RPC_URL`,
    )
  }
  return {
    name,
    passphrase: d.passphrase,
    rpcUrl: env.serverRpcUrl?.trim() || sharedRpcUrl,
    horizonUrl: env.horizonUrl?.trim() || d.horizonUrl,
    explorerBase: `https://stellar.expert/explorer/${name}`,
  }
}

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

export const explorerTxUrl = (hash: string) => `${NETWORK.explorerBase}/tx/${hash}`
export const explorerAccountUrl = (address: string) =>
  `${NETWORK.explorerBase}/account/${address}`
export const explorerContractUrl = (id: string) =>
  `${NETWORK.explorerBase}/contract/${id}`
