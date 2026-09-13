// End-to-end testnet verification for one book.
//
// Takes the underlying as its first argument, because there is an instance per
// underlying and nothing about a lifecycle is shared between two of them: a
// position id is only unique within an instance, the collateral is a different
// token, and the sizes that make sense on one book are nonsense on the other.
//
// Mirrors exactly what the application does to open a position, because the
// Stellar CLI cannot: the contract requires authorization from the writer AND
// the quoter, and only one of those is the transaction source. The CLI signs
// the transaction; the quoter's entry has to be signed on its own. That round
// trip is what /api/vault/authorize performs in production, and what this
// script performs locally against the quoter's key.
//
//   open   → writes covered calls and cash-secured puts, both sides of the
//            strike, and reports the ids
//   settle → settles them once expired and prints every outcome and balance
//
// Usage:
//   node scripts/verify-lifecycle.mjs XLM open
//   node scripts/verify-lifecycle.mjs BTC fund [cash] [underlying]
//   node scripts/verify-lifecycle.mjs BTC open
//   node scripts/verify-lifecycle.mjs BTC settle <id> [<id> ...]
//   node scripts/verify-lifecycle.mjs BTC stats
//
// `fund` exists because a freshly deployed book has two empty pools and the
// contract refuses to write against them — correctly, since a premium it cannot
// pay and an assignment it cannot deliver are the two promises a vault must
// never make.

import {
  Address,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
  authorizeEntry,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from '@stellar/stellar-sdk'
import { execFileSync } from 'node:child_process'

try {
  process.loadEnvFile('.env.local')
} catch {
  // Rely on an already-exported environment.
}

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? 'https://soroban-testnet.stellar.org'
const PASSPHRASE = Networks.TESTNET
const server = new rpc.Server(RPC_URL)

const [, , symbolArg, cmd, ...rest] = process.argv
const SYMBOL = (symbolArg ?? '').toUpperCase()

// The book under test. Read from the same environment the app reads, so this
// verifies the instance the app would actually write to rather than one named
// in a script.
const BOOKS = {
  XLM: {
    vault: process.env.VAULT_CONTRACT ?? process.env.NEXT_PUBLIC_VAULT_CONTRACT,
    // Sizes that straddle a sub-dollar spot.
    size: { call: 100, put: 20, callPremium: 1, putPremium: 0.8 },
    funder: { cash: 'lusty-distributor', underlying: null },
  },
  BTC: {
    vault: process.env.NEXT_PUBLIC_VAULT_CONTRACT_BTC,
    // Sizes that fit a 0.05 BTC position cap and a $1,500 put cap.
    size: { call: 0.01, put: 500, callPremium: 8, putPremium: 5 },
    funder: { cash: 'lusty-distributor', underlying: 'env:LBTC_DISTRIBUTOR_SECRET' },
  },
}

const BOOK = BOOKS[SYMBOL]
if (!BOOK?.vault) {
  console.error(`usage: node scripts/verify-lifecycle.mjs <${Object.keys(BOOKS).join('|')}> <fund|open|settle|stats>`)
  console.error(SYMBOL ? `  ${SYMBOL} has no vault instance configured` : '')
  process.exit(1)
}
const VAULT = BOOK.vault

/** Read a secret out of the Stellar CLI's local identity store. */
const secretOf = (alias) =>
  execFileSync('stellar', ['keys', 'show', alias], { encoding: 'utf8' }).trim()

/** A key named either by CLI alias or by an environment variable. */
const keyOf = (name) =>
  Keypair.fromSecret(
    name.startsWith('env:') ? process.env[name.slice(4)] : secretOf(name),
  )

const writer = Keypair.fromSecret(secretOf('lusty-writer'))
const quoter = Keypair.fromSecret(secretOf('lusty-quoter'))

const TOKEN = 10n ** 7n // 7-decimal token units
const ORACLE = 10n ** 14n // Reflector price scale

/** Token units at 7 decimals — every Stellar asset, issued or native. */
const units = (n) => BigInt(Math.round(n * 1e7))
const usd = (n) => BigInt(Math.round(n * 1e14))
const fromToken = (v) => Number(BigInt(v)) / 1e7
const fromOracle = (v) => Number(BigInt(v)) / 1e14

async function simulate(tx, label) {
  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`${label}: ${sim.error}`)
  }
  return sim
}

async function read(method, args = []) {
  const tx = new TransactionBuilder(await server.getAccount(writer.publicKey()), {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new Contract(VAULT).call(method, ...args))
    .setTimeout(30)
    .build()
  const sim = await simulate(tx, method)
  return scValToNative(sim.result.retval)
}

async function submit(tx, label) {
  const sent = await server.sendTransaction(tx)
  if (sent.status === 'ERROR') {
    throw new Error(`${label} rejected: ${JSON.stringify(sent.errorResult)}`)
  }
  for (let i = 0; i < 40; i++) {
    const got = await server.getTransaction(sent.hash)
    if (got.status === 'SUCCESS') return { result: got, hash: sent.hash }
    if (got.status === 'FAILED') {
      throw new Error(`${label} failed on chain: ${sent.hash}`)
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`${label} not confirmed: ${sent.hash}`)
}

/** The application's open flow, with the quoter co-signature done locally. */
async function open({ kind, amount, strike, expiry, premium, label }) {
  const args = [
    new Address(writer.publicKey()).toScVal(),
    nativeToScVal(kind, { type: 'u32' }),
    nativeToScVal(amount, { type: 'i128' }),
    nativeToScVal(strike, { type: 'i128' }),
    nativeToScVal(BigInt(expiry), { type: 'u64' }),
    nativeToScVal(premium, { type: 'i128' }),
    // The contract checks the named quoter against its own set and demands
    // authorization from that exact address, so the call has to declare which
    // key is co-signing before there is anything to sign.
    new Address(quoter.publicKey()).toScVal(),
  ]

  const build = async (auth) =>
    new TransactionBuilder(await server.getAccount(writer.publicKey()), {
      fee: BASE_FEE,
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(
        auth
          ? Operation.invokeContractFunction({ contract: VAULT, function: 'open', args, auth })
          : new Contract(VAULT).call('open', ...args),
      )
      .setTimeout(180)
      .build()

  // 1. Learn which entries need authorizing.
  const probe = await simulate(await build(), `${label} probe`)

  // 2. The quoter signs its own entry, and only its own — the writer's entry
  //    carries source-account credentials and is covered by the tx signature.
  const { sequence } = await server.getLatestLedger()
  const auth = await Promise.all(
    (probe.result?.auth ?? []).map(async (entry) => {
      const creds = entry.credentials()
      if (creds.switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
        return entry
      }
      const addr = Address.fromScAddress(creds.address().address()).toString()
      if (addr !== quoter.publicKey()) return entry
      return authorizeEntry(entry, quoter, sequence + 100, PASSPHRASE)
    }),
  )

  // 3. Rebuild carrying that signature, price the larger footprint, sign, send.
  const authorized = await build(auth)
  const sim = await simulate(authorized, `${label} authorized`)
  const prepared = rpc.assembleTransaction(authorized, sim).build()
  prepared.sign(writer)

  const { result, hash } = await submit(prepared, label)
  const id = Number(scValToNative(result.returnValue))
  console.log(`  ${label.padEnd(28)} → position #${id}  ${hash}`)
  return id
}

async function settle(id) {
  const tx = new TransactionBuilder(await server.getAccount(writer.publicKey()), {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new Contract(VAULT).call('settle', nativeToScVal(BigInt(id), { type: 'u64' })))
    .setTimeout(180)
    .build()
  const sim = await simulate(tx, `settle ${id}`)
  const prepared = rpc.assembleTransaction(tx, sim).build()
  prepared.sign(writer)
  const { result, hash } = await submit(prepared, `settle ${id}`)
  return { outcome: scValToNative(result.returnValue), hash }
}

async function printStats() {
  const s = await read('stats')
  console.log('\n  vault state')
  console.log(`    cash pool        ${fromToken(s.cash_balance).toFixed(4)} LUSD`)
  console.log(`    underlying pool  ${fromToken(s.underlying_balance).toFixed(6)} ${SYMBOL}`)
  console.log(`    escrowed         call ${fromToken(s.escrowed_call).toFixed(6)} ${SYMBOL} · put ${fromToken(s.escrowed_put).toFixed(4)} LUSD`)
  console.log(`    owed if assigned call ${fromToken(s.owed_call).toFixed(4)} LUSD · put ${fromToken(s.owed_put).toFixed(6)} ${SYMBOL}`)
  console.log(`    positions issued ${s.next_id}`)
  // The solvency invariant the contract enforces, restated from outside.
  const freeCash = BigInt(s.cash_balance) - BigInt(s.escrowed_put)
  const freeUnder = BigInt(s.underlying_balance) - BigInt(s.escrowed_call)
  console.log(`    solvent          calls ${freeCash >= BigInt(s.owed_call)} · puts ${freeUnder >= BigInt(s.owed_put)}`)
}

/** Top up a pool. One-way in: `fund` and `fund_underlying` never pay back. */
async function fund(method, funderName, amount) {
  const funder = keyOf(funderName)
  const tx = new TransactionBuilder(await server.getAccount(funder.publicKey()), {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      new Contract(VAULT).call(
        method,
        new Address(funder.publicKey()).toScVal(),
        nativeToScVal(amount, { type: 'i128' }),
      ),
    )
    .setTimeout(180)
    .build()
  const sim = await simulate(tx, method)
  const prepared = rpc.assembleTransaction(tx, sim).build()
  prepared.sign(funder)
  const { hash } = await submit(prepared, method)
  console.log(`  ${method.padEnd(18)} ${fromToken(amount)} from ${funder.publicKey().slice(0, 8)}…  ${hash}`)
}

/**
 * Spot from the same oracle the vault settles against.
 *
 * Read from Reflector rather than written into this file: strikes placed around
 * a hardcoded price stop straddling it the moment the market moves, and a run
 * where both positions land on the same side of the strike exercises one
 * settlement branch twice and the other never.
 */
async function oracleSpot() {
  const cfg = await read('config')
  const asset = xdr.ScVal.scvVec([
    nativeToScVal('Other', { type: 'symbol' }),
    nativeToScVal(cfg.feed, { type: 'symbol' }),
  ])
  const tx = new TransactionBuilder(await server.getAccount(writer.publicKey()), {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new Contract(cfg.oracle).call('lastprice', asset))
    .setTimeout(30)
    .build()
  const sim = await simulate(tx, 'lastprice')
  const record = scValToNative(sim.result.retval)
  return record ? fromOracle(record.price) : null
}

if (cmd === 'fund') {
  const [cashArg, underArg] = rest
  console.log(`vault ${VAULT} (${SYMBOL})`)
  if (cashArg) await fund('fund', BOOK.funder.cash, units(Number(cashArg)))
  if (underArg) {
    if (!BOOK.funder.underlying) {
      throw new Error(`${SYMBOL}'s underlying pool has no configured funder`)
    }
    await fund('fund_underlying', BOOK.funder.underlying, units(Number(underArg)))
  }
  await printStats()
} else if (cmd === 'open') {
  const spot = await oracleSpot()
  const now = Math.floor(Date.now() / 1000)
  // Land on the feed's 300s grid, far enough out to open before it passes.
  const expiry = (Math.floor(now / 300) + 3) * 300
  console.log(`vault ${VAULT} (${SYMBOL})`)
  console.log(`writer ${writer.publicKey()}`)
  console.log(`spot ${spot ?? 'unreadable'}`)
  console.log(`expiry ${expiry} (in ${expiry - now}s)\n`)

  // Strikes straddle the live price, so one of each pair is assigned and the
  // other kept — both settlement branches exercised in one run, at whatever
  // the asset happens to be worth rather than at a number written here.
  if (!spot) throw new Error('no oracle price: cannot place strikes around spot')
  const { call, put, callPremium, putPremium } = BOOK.size
  const above = usd(spot * 1.02)
  const below = usd(spot * 0.98)
  const fmt = (n) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`

  const ids = []
  ids.push(await open({ kind: 0, amount: units(call), strike: above, expiry, premium: units(callPremium), label: `call OTM ${fmt(spot * 1.02)}` }))
  ids.push(await open({ kind: 0, amount: units(call), strike: below, expiry, premium: units(callPremium * 1.5), label: `call ITM ${fmt(spot * 0.98)}` }))
  ids.push(await open({ kind: 1, amount: units(put), strike: below, expiry, premium: units(putPremium), label: `put  OTM ${fmt(spot * 0.98)}` }))
  ids.push(await open({ kind: 1, amount: units(put), strike: above, expiry, premium: units(putPremium * 1.5), label: `put  ITM ${fmt(spot * 1.02)}` }))

  await printStats()
  console.log(`\n  settle after ${expiry}:`)
  console.log(`    node scripts/verify-lifecycle.mjs ${SYMBOL} settle ${ids.join(' ')}`)
} else if (cmd === 'settle') {
  for (const id of rest) {
    const p = await read('position', [nativeToScVal(BigInt(id), { type: 'u64' })])
    const side = Number(p.kind) === 0 ? 'call' : 'put'
    try {
      const { outcome, hash } = await settle(id)
      console.log(`  #${id} ${side} strike $${fromOracle(p.strike).toFixed(4)} → ${outcome}  ${hash}`)
    } catch (e) {
      console.log(`  #${id} ${side} strike $${fromOracle(p.strike).toFixed(4)} → ${e.message}`)
    }
  }
  await printStats()
} else {
  await printStats()
}
