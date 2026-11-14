// The network an operator script signs for, resolved exactly as the app
// resolves it: the same .env.local, the same variables, the same function
// (src/lib/network.mjs). No script names a passphrase or an endpoint of its
// own, so a deploy, a verify or a settle cannot be pointed at a different
// network than the app it serves.
//
// Scripts are run from the repository root (`node scripts/<name>.mjs`), which
// is where .env.local is read from. Variables already exported win over the
// file, as they do for the app.

import { resolveNetwork } from '../../src/lib/network.mjs'

try {
  process.loadEnvFile('.env.local')
} catch {
  // No local file: rely on the environment already exported.
}

export const NETWORK = resolveNetwork({
  network: process.env.NEXT_PUBLIC_STELLAR_NETWORK,
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL,
  serverRpcUrl: process.env.SOROBAN_RPC_URL,
  horizonUrl: process.env.NEXT_PUBLIC_HORIZON_URL,
})

export const IS_TESTNET = NETWORK.name === 'testnet'
export const PASSPHRASE = NETWORK.passphrase
export const RPC_URL = NETWORK.rpcUrl
export const HORIZON_URL = NETWORK.horizonUrl

/**
 * Stops a script that only makes sense on testnet (friendbot, the LUSD and
 * LBTC mints, the test anchor, the seeded DEX books) before it builds anything.
 */
export function requireTestnet(what) {
  if (IS_TESTNET) return
  console.error(
    `${what} is testnet-only; NEXT_PUBLIC_STELLAR_NETWORK is "${NETWORK.name}".`,
  )
  process.exit(1)
}

/** Funds a fresh testnet account. Refuses on any other network. */
export async function friendbot(address) {
  requireTestnet('friendbot')
  const r = await fetch(
    `${process.env.FRIENDBOT_URL ?? 'https://friendbot.stellar.org'}/?addr=${address}`,
  )
  if (!r.ok) throw new Error(`friendbot ${r.status}: ${await r.text()}`)
}
