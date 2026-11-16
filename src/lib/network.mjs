// Which Stellar network a configuration names, and what follows from it.
//
// Plain JavaScript on purpose: the app (lib/stellar.ts) and the operator
// scripts (scripts/lib/network.mjs) both resolve the network through this one
// function, so a deploy or settle script cannot sign for a different network
// than the app it serves. Node runs it without a build step; Next and vitest
// import it like any other module.

import { Networks } from '@stellar/stellar-sdk'

/** @typedef {'testnet' | 'public'} StellarNetworkName */

/**
 * @typedef {object} StellarNetwork
 * @property {StellarNetworkName} name
 * @property {string} passphrase
 * @property {string} rpcUrl
 * @property {string} horizonUrl
 * @property {string} explorerBase stellar.expert's root for this network
 * @property {{ code: string, issuer: string }} usdc Circle's USDC on this network
 */

/**
 * @typedef {object} NetworkEnv
 * @property {string} [network] NEXT_PUBLIC_STELLAR_NETWORK
 * @property {string} [rpcUrl] NEXT_PUBLIC_RPC_URL, the RPC the browser sees too
 * @property {string} [serverRpcUrl] SOROBAN_RPC_URL, a server-only override
 * @property {string} [horizonUrl] NEXT_PUBLIC_HORIZON_URL
 */

/** @type {Record<StellarNetworkName, { passphrase: string, rpcUrl?: string, horizonUrl: string, usdcIssuer: string }>} */
const DEFAULTS = {
  testnet: {
    passphrase: Networks.TESTNET,
    rpcUrl: 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  },
  // SDF runs no public-network RPC, so there is no default to fall back on:
  // the provider is a deployment choice and has to be named.
  public: {
    passphrase: Networks.PUBLIC,
    horizonUrl: 'https://horizon.stellar.org',
    usdcIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  },
}

/**
 * Resolves the network from its configuration. Unset means testnet, which is
 * what every deployment before the variable existed ran on; anything that is
 * neither name throws, as does the public network without an RPC the browser
 * can see (a server-only one would start the server and fail every browser).
 *
 * @param {NetworkEnv} env
 * @returns {StellarNetwork}
 */
export function resolveNetwork(env) {
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
    throw new Error(`the ${name} network has no default RPC; set NEXT_PUBLIC_RPC_URL`)
  }
  return {
    name,
    passphrase: d.passphrase,
    rpcUrl: env.serverRpcUrl?.trim() || sharedRpcUrl,
    horizonUrl: env.horizonUrl?.trim() || d.horizonUrl,
    explorerBase: `https://stellar.expert/explorer/${name}`,
    usdc: { code: 'USDC', issuer: d.usdcIssuer },
  }
}
