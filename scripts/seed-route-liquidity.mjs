// Seed the direct USDC → LUSD book the routing allowlist takes.
//
//   node scripts/seed-route-liquidity.mjs              # 100000 LUSD at par
//   node scripts/seed-route-liquidity.mjs --amount 0   # withdraw the offer
//
// The usdc->lusd route is direct only and holds its price within 1% of par
// (lib/routing/allowlist). On testnet nothing trades LUSD against USDC
// directly, and the only path the finder offers runs through XLM at several
// times par, so every route is refused and a USDC put falls back to the
// bridge. This puts one sell offer on the direct book: the distributor sells
// LUSD for USDC at exactly 1.
//
// One direction on purpose. LUSD is free from the faucet; an offer selling
// USDC for it would let anyone turn faucet LUSD into the distributor's USDC,
// which is the drain the bridge's reverse direction was closed for.
//
// Re-running updates the same offer in place. It touches no other offer, so
// seed-lusd-offers.mjs and this script can each be refreshed independently.

import fs from 'node:fs'
import path from 'node:path'
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'

// Minimal .env.local loader so the script runs without dotenv.
const envPath = path.resolve('.env.local')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) process.env[m[1]] = m[2].trim()
  }
}

const HORIZON = process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org'
const LUSD_ISSUER =
  process.env.NEXT_PUBLIC_LUSD_ISSUER ?? 'GBCMRD6NDL2RAJUOFQ25EHZVO3IRIGNESWE4QDRFB4AVFIP7IT5BRCJ6'
const USDC_CODE = process.env.NEXT_PUBLIC_ANCHOR_ASSET_CODE ?? 'USDC'
const USDC_ISSUER =
  process.env.NEXT_PUBLIC_ANCHOR_ASSET_ISSUER ??
  'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const DIST_SECRET = process.env.LUSD_DISTRIBUTOR_SECRET

if (!DIST_SECRET) {
  console.error('missing LUSD_DISTRIBUTOR_SECRET in .env.local')
  process.exit(1)
}

const amountArg = process.argv.indexOf('--amount')
const AMOUNT = amountArg > -1 ? Number(process.argv[amountArg + 1]) : 100_000
if (!isFinite(AMOUNT) || AMOUNT < 0) {
  console.error('--amount must be a non-negative number')
  process.exit(1)
}

const server = new Horizon.Server(HORIZON)
const dist = Keypair.fromSecret(DIST_SECRET)
const lusd = new Asset('LUSD', LUSD_ISSUER)
const usdc = new Asset(USDC_CODE, USDC_ISSUER)

const isPair = (o) =>
  o.selling.asset_code === 'LUSD' &&
  o.selling.asset_issuer === LUSD_ISSUER &&
  o.buying.asset_code === USDC_CODE &&
  o.buying.asset_issuer === USDC_ISSUER

async function main() {
  const { records } = await server.offers().forAccount(dist.publicKey()).call()
  const existing = records.find(isPair)
  if (!existing && AMOUNT === 0) {
    console.log('no LUSD/USDC offer to withdraw')
    return
  }

  const account = await server.loadAccount(dist.publicKey())
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.manageSellOffer({
        selling: lusd,
        buying: usdc,
        amount: AMOUNT.toFixed(7),
        price: '1',
        offerId: existing ? existing.id : '0',
      }),
    )
    .setTimeout(120)
    .build()
  tx.sign(dist)
  const res = await server.submitTransaction(tx)
  console.log(
    `${AMOUNT === 0 ? 'withdrew' : existing ? 'updated' : 'placed'} LUSD/USDC offer at par: ` +
      `${AMOUNT} LUSD · tx ${res.hash}`,
  )

  const { records: after } = await server.offers().forAccount(dist.publicKey()).call()
  const offer = after.find(isPair)
  if (offer) console.log(`offer ${offer.id}: sells ${offer.amount} LUSD @ ${offer.price} USDC`)
}

main().catch((e) => {
  console.error(e?.response?.data?.extras?.result_codes ?? e?.message ?? e)
  process.exit(1)
})
