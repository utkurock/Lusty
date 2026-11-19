// Compare what the network runs against the release manifest.
//
//   node scripts/check-drift.mjs
//   node scripts/check-drift.mjs --manifest release/testnet.json
//
// Reads every book in release/<network>.json (wasm hash, config, limits,
// quoter set) and every account those name (signers and thresholds), and
// prints each difference. Exits 0 when there is none, 1 on drift, 2 when the
// manifest is for another network than the one configured. Reads only: it
// signs nothing and needs no key.

import { Horizon } from '@stellar/stellar-sdk'
import { readFileSync } from 'node:fs'
import { NETWORK, PASSPHRASE, RPC_URL, HORIZON_URL } from './lib/network.mjs'
import {
  compareRelease,
  describeDrift,
  networkReaders,
  observeRelease,
} from '../src/lib/drift.mjs'

const flag = process.argv.indexOf('--manifest')
const path = flag > 0 ? process.argv[flag + 1] : `release/${NETWORK.name}.json`
const manifest = JSON.parse(readFileSync(path, 'utf8'))

if (manifest.network !== NETWORK.name) {
  console.error(`${path} is for ${manifest.network}; NEXT_PUBLIC_STELLAR_NETWORK is ${NETWORK.name}.`)
  process.exit(2)
}

const horizon = new Horizon.Server(HORIZON_URL)
const readers = networkReaders({
  rpcUrl: RPC_URL,
  passphrase: PASSPHRASE,
  loadHorizonAccount: (address) => horizon.loadAccount(address),
})

const observed = await observeRelease(manifest, readers)
const drift = compareRelease(manifest, observed)

const books = Object.keys(manifest.books).join(', ')
const accounts = Object.keys(observed.accounts).length
if (drift.length === 0) {
  console.log(`${NETWORK.name}: no drift (${books}; ${accounts} accounts) against ${path}`)
  process.exit(0)
}
console.error(`${NETWORK.name}: ${drift.length} difference(s) against ${path}`)
for (const d of drift) console.error(`  ${describeDrift(d)}`)
process.exit(1)
