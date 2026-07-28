// End-to-end testnet verification for the vault contract.
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
//   node scripts/verify-vault.mjs open
//   node scripts/verify-vault.mjs settle <id> [<id> ...]
//   node scripts/verify-vault.mjs stats

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

const RPC_URL = 'https://soroban-testnet.stellar.org'
const PASSPHRASE = Networks.TESTNET
const VAULT = process.env.VAULT_CONTRACT ?? 'CDNES2LSMDPISV6W3PT3KHZXCLGBU6FG2EK6S3V422V6ZYIMVRGXTHKG'

const server = new rpc.Server(RPC_URL)

/** Read a secret out of the Stellar CLI's local identity store. */
const secretOf = (alias) =>
  execFileSync('stellar', ['keys', 'show', alias], { encoding: 'utf8' }).trim()

const writer = Keypair.fromSecret(secretOf('lusty-writer'))
const quoter = Keypair.fromSecret(secretOf('lusty-quoter'))

const TOKEN = 10n ** 7n // 7-decimal token units
const ORACLE = 10n ** 14n // Reflector price scale

const xlm = (n) => BigInt(Math.round(n * 1e7))
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
  console.log(`    underlying pool  ${fromToken(s.underlying_balance).toFixed(4)} XLM`)
  console.log(`    escrowed         call ${fromToken(s.escrowed_call).toFixed(4)} XLM · put ${fromToken(s.escrowed_put).toFixed(4)} LUSD`)
  console.log(`    owed if assigned call ${fromToken(s.owed_call).toFixed(4)} LUSD · put ${fromToken(s.owed_put).toFixed(4)} XLM`)
  console.log(`    positions issued ${s.next_id}`)
  // The solvency invariant the contract enforces, restated from outside.
  const freeCash = BigInt(s.cash_balance) - BigInt(s.escrowed_put)
  const freeUnder = BigInt(s.underlying_balance) - BigInt(s.escrowed_call)
  console.log(`    solvent          calls ${freeCash >= BigInt(s.owed_call)} · puts ${freeUnder >= BigInt(s.owed_put)}`)
}

const [, , cmd, ...rest] = process.argv

if (cmd === 'open') {
  const spot = fromOracle((await read('lastprice_probe').catch(() => null)) ?? 0n) || null
  const now = Math.floor(Date.now() / 1000)
  // Land on the feed's 300s grid, far enough out to open before it passes.
  const expiry = (Math.floor(now / 300) + 3) * 300
  console.log(`vault ${VAULT}`)
  console.log(`writer ${writer.publicKey()}`)
  console.log(`expiry ${expiry} (in ${expiry - now}s)\n`)

  const ids = []
  // Strikes straddle spot (~$0.172) so both outcomes are exercised.
  ids.push(await open({ kind: 0, amount: xlm(100), strike: usd(0.20), expiry, premium: xlm(1), label: 'call OTM  $0.20' }))
  ids.push(await open({ kind: 0, amount: xlm(100), strike: usd(0.15), expiry, premium: xlm(1.5), label: 'call ITM  $0.15' }))
  ids.push(await open({ kind: 1, amount: xlm(20), strike: usd(0.15), expiry, premium: xlm(0.8), label: 'put  OTM  $0.15' }))
  ids.push(await open({ kind: 1, amount: xlm(20), strike: usd(0.20), expiry, premium: xlm(1.2), label: 'put  ITM  $0.20' }))

  await printStats()
  console.log(`\n  settle after ${expiry}:`)
  console.log(`    node scripts/verify-vault.mjs settle ${ids.join(' ')}`)
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
