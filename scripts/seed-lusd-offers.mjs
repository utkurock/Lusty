// Seed the Stellar testnet DEX with XLM ↔ LUSD sell offers so the site's
// swap (classic pathPaymentStrictSend) has liquidity to fill against.
//
//   node scripts/seed-lusd-offers.mjs
//
// Reads the distributor secret and LUSD issuer from .env.local. Fetches the
// live XLM/USD spot from Binance, then places two manageSellOffer ops:
//   1) selling LUSD  for XLM   (fills XLM → LUSD swaps)
//   2) selling XLM   for LUSD  (fills LUSD → XLM swaps)
//
// Re-running replaces the previous offers (same offerId slot) — use this
// to refresh prices periodically.

import fs from 'node:fs'
import path from 'node:path'
import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  Networks,
  BASE_FEE,
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
const ISSUER = process.env.NEXT_PUBLIC_LUSD_ISSUER
const DIST_SECRET = process.env.LUSD_DISTRIBUTOR_SECRET

if (!ISSUER || !DIST_SECRET) {
  console.error('missing NEXT_PUBLIC_LUSD_ISSUER / LUSD_DISTRIBUTOR_SECRET in .env.local')
  process.exit(1)
}

async function fetchXlmUsd() {
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=XLMUSDT')
    const j = await r.json()
    return parseFloat(j.price)
  } catch {
    return 0.155
  }
}

async function main() {
  const server = new Horizon.Server(HORIZON)
  const dist = Keypair.fromSecret(DIST_SECRET)
  const lusd = new Asset('LUSD', ISSUER)
  const xlm = Asset.native()

  // 1. Delete any offers the distributor already has so we free up capital.
  const { records: existing } = await server.offers().forAccount(dist.publicKey()).call()
  if (existing.length > 0) {
    console.log(`→ deleting ${existing.length} existing offer(s)`)
    const acc = await server.loadAccount(dist.publicKey())
    const b = new TransactionBuilder(acc, {
      fee: String(Number(BASE_FEE) * Math.max(existing.length, 1)),
      networkPassphrase: Networks.TESTNET,
    })
    for (const o of existing) {
      b.addOperation(
        Operation.manageSellOffer({
          selling:
            o.selling.asset_type === 'native'
              ? Asset.native()
              : new Asset(o.selling.asset_code, o.selling.asset_issuer),
          buying:
            o.buying.asset_type === 'native'
              ? Asset.native()
              : new Asset(o.buying.asset_code, o.buying.asset_issuer),
          amount: '0',
          price: o.price,
          offerId: o.id,
        })
      )
    }
    const dtx = b.setTimeout(60).build()
    dtx.sign(dist)
    try {
      const r = await server.submitTransaction(dtx)
      console.log('   cleared:', r.hash)
    } catch (e) {
      console.error('delete failed:', e?.response?.data?.extras ?? e)
      process.exit(1)
    }
  }

  const spot = await fetchXlmUsd()
  console.log('XLM/USD spot:', spot)

  // Apply a 5% spread on each side so the two offers don't self-cross
  // and the distributor takes a small fee vs mid.
  const SPREAD = 0.05
  // Offer 1: sell LUSD, buy XLM. Ask: more XLM per LUSD than fair.
  const xlmPerLusd = (1 / (spot * (1 - SPREAD))).toFixed(7)
  // Offer 2: sell XLM, buy LUSD. Ask: more LUSD per XLM than fair.
  const lusdPerXlm = (spot * (1 + SPREAD)).toFixed(7)

  console.log(`will quote (with ${SPREAD * 100}% spread):`)
  console.log(`  1 LUSD asks ${xlmPerLusd} XLM`)
  console.log(`  1 XLM  asks ${lusdPerXlm} LUSD`)

  const account = await server.loadAccount(dist.publicKey())

  const tx = new TransactionBuilder(account, {
    fee: String(Number(BASE_FEE) * 2),
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.manageSellOffer({
        selling: lusd,
        buying: xlm,
        amount: '50000', // up to 50k LUSD offered for XLM
        price: xlmPerLusd,
        offerId: '0', // new offer; rerunning will add a fresh offer — use clear script below to reset
      })
    )
    .addOperation(
      Operation.manageSellOffer({
        selling: xlm,
        buying: lusd,
        amount: '25000', // up to 25k XLM offered for LUSD
        price: lusdPerXlm,
        offerId: '0',
      })
    )
    .setTimeout(60)
    .build()

  tx.sign(dist)
  try {
    const res = await server.submitTransaction(tx)
    console.log('✓ offers placed, hash:', res.hash)
  } catch (e) {
    console.error('submit failed:', e?.response?.data?.extras ?? e)
    process.exit(1)
  }
}

main()
