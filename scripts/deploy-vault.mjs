// Deploy a vault instance for one underlying.
//
//   node scripts/deploy-vault.mjs BTC
//   node scripts/deploy-vault.mjs BTC --dry-run
//   node scripts/deploy-vault.mjs BTC --wasm contracts/target/wasm32v1-none/release/lusty_vault.wasm
//
// --wasm is for a new contract version (v4 → v5): it uploads that build and
// deploys from its hash instead of the reference instance's. Without it the
// new book runs exactly the code the reference runs, as below.
//
// One instance per underlying is the whole shape of multi-asset here: the
// contract is already parameterised, so a second book is a second deployment
// of the same code rather than a per-asset dimension added to the first. That
// is what keeps BTC's escrow, exposure, limits and solvency guard out of XLM's
// — there is no shared balance to leak across, and no Rust to change.
//
// The wasm is not rebuilt or re-uploaded: the new instance runs the SAME wasm
// hash the reference instance runs, read off the network. Building from source
// would produce a binary that ought to be identical and cannot be shown to be,
// and "BTC settles the code XLM settles" is a claim worth being able to make
// by construction.
//
// Everything else about the desk is copied from the reference instance for the
// same reason — same oracle, same treasury, same admin, same quoter set — so
// what differs between two books is exactly what the registry says differs:
// the feed, the collateral, and the limits.

import {
  Address,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from '@stellar/stellar-sdk'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

// The app's own configuration, read the same way the app reads it. A script
// run by hand has no framework loading it, and a deploy that silently fell back
// to defaults would put the book on the wrong collateral.
try {
  process.loadEnvFile('.env.local')
} catch {
  // No local file: rely on the environment already exported.
}

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? 'https://soroban-testnet.stellar.org'
const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org'
// Reads are simulated, never sent, so the account named here only has to exist.
const PROBE_ACCOUNT = 'GCXVANOIFHM7IAAZTDEEOYW7WUDO7ETVJYVEO74LA23JSXQJP4TAJVUX'
const PASSPHRASE = Networks.TESTNET
const server = new rpc.Server(RPC_URL)

/** Read a secret out of the Stellar CLI's local identity store. */
const secretOf = (alias) =>
  execFileSync('stellar', ['keys', 'show', alias], { encoding: 'utf8' }).trim()

// Stroops. Every Stellar asset carries 7 decimals, issued or native, so the
// contract's i128 limits are in the same scale whatever the collateral is.
const UNIT = 10_000_000n
const stroops = (n) => BigInt(Math.round(Number(n) * 1e7))

// What an underlying's instance is constructed with, read off the environment
// by the same key convention `lib/assets/config.ts` declares.
//
// This used to be a table with one entry in it, which meant listing a third
// book was a code change to a deploy script — while the app it deploys for had
// just been rebuilt so that listing one is a config entry and nothing else.
// A table naming one asset in a tool that takes the asset as an argument is the
// same defect M2-06 took out of `lib/`, one directory over.
//
// The caps here are the contract's own: trustless, enforced on every write, and
// deliberately the OUTER bound rather than the operating envelope. The tighter
// figures the desk quotes inside live in the app (`VAULT_*_<SYM>`). They are
// separate keys on purpose — the two instances already in flight do not agree
// on a single rule relating them (XLM's per-expiry cap is its monthly capacity
// divided by three, BTC's is the whole month), so deriving one from the other
// would encode a rule neither of them follows.
//
// Whatever is deployed has to end up in the book's `onchainLimits` in
// lib/assets/config.ts, which is what lib/vault-limits.ts reconciles the
// instance against before anything is quoted. Read it back with `--check`
// rather than copying it from here: two records of one rule that nobody
// compares is how a limit stops being in force without anyone noticing.
const LIMIT_KEYS = {
  max_position_call: 'VAULT_ONCHAIN_MAX_POSITION_CALL',
  max_expiry_call: 'VAULT_ONCHAIN_MAX_EXPIRY_CALL',
  max_position_put: 'VAULT_ONCHAIN_MAX_POSITION_PUT',
  max_expiry_put: 'VAULT_ONCHAIN_MAX_EXPIRY_PUT',
}

/** The one cap that is not asset-specific: it bounds the quoter, not the market. */
const DEFAULT_PREMIUM_BPS = 2000

function amountFromEnv(key) {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === '') return null
  const n = Number(raw)
  // No fallback. A cap the deployment did not state is not a looser cap, it is
  // a number nobody chose, and this one is enforced on every write for the life
  // of the instance.
  if (!isFinite(n) || n <= 0) throw new Error(`${key} is not a positive amount: ${raw}`)
  return stroops(n)
}

function bookFromEnv(symbol) {
  const limits = {}
  const missing = []
  for (const [field, prefix] of Object.entries(LIMIT_KEYS)) {
    const key = `${prefix}_${symbol}`
    const value = amountFromEnv(key)
    if (value === null) missing.push(key)
    else limits[field] = value
  }
  const bps = process.env[`VAULT_ONCHAIN_MAX_PREMIUM_BPS_${symbol}`]
  limits.max_premium_bps = bps ? Number(bps) : DEFAULT_PREMIUM_BPS
  if (!Number.isInteger(limits.max_premium_bps) || limits.max_premium_bps <= 0 || limits.max_premium_bps > 10_000) {
    throw new Error(`VAULT_ONCHAIN_MAX_PREMIUM_BPS_${symbol} must be 1..10000, got ${bps}`)
  }

  return {
    feed: process.env[`REFLECTOR_FEED_SYMBOL_${symbol}`] ?? symbol,
    token: process.env[`NEXT_PUBLIC_${symbol}_CONTRACT`] ?? null,
    // Null means "whatever the reference instance settles in". Every book on
    // this desk pays premiums in the same cash today, and reading it off the
    // live instance is stronger than reading it off a local file that may
    // disagree with what XLM is actually escrowing against.
    cash: process.env.NEXT_PUBLIC_LUSD_CONTRACT ?? null,
    limits,
    missing,
  }
}

function limitsScVal(l) {
  // Soroban structs are maps keyed by symbol, in sorted key order.
  const entry = (key, val) =>
    new xdr.ScMapEntry({ key: nativeToScVal(key, { type: 'symbol' }), val })
  const i128 = (v) => nativeToScVal(v, { type: 'i128' })
  return xdr.ScVal.scvMap([
    entry('max_expiry_call', i128(l.max_expiry_call)),
    entry('max_expiry_put', i128(l.max_expiry_put)),
    entry('max_position_call', i128(l.max_position_call)),
    entry('max_position_put', i128(l.max_position_put)),
    entry('max_premium_bps', nativeToScVal(l.max_premium_bps, { type: 'u32' })),
  ])
}

/**
 * The env key a book's vault address lives under, as lib/assets/config.ts
 * declares it: XLM was the first book and kept the unsuffixed name.
 */
const vaultEnvKey = (symbol) =>
  symbol === 'XLM' ? 'NEXT_PUBLIC_VAULT_CONTRACT' : `NEXT_PUBLIC_VAULT_CONTRACT_${symbol}`

/** The value after a flag, e.g. `--wasm <path>`. */
function flagValue(name) {
  const i = process.argv.indexOf(name)
  if (i === -1) return null
  const v = process.argv[i + 1]
  if (!v || v.startsWith('--')) throw new Error(`${name} needs a value`)
  return v
}

/** Read a function off a deployed instance without sending anything. */
async function read(contractId, fn, probe, ...args) {
  const tx = new TransactionBuilder(await server.getAccount(probe), {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(fn, ...args))
    .setTimeout(30)
    .build()
  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${fn}: ${sim.error}`)
  return scValToNative(sim.result.retval)
}

/** The wasm hash an instance is running. */
async function wasmHashOf(contractId) {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  )
  const { entries } = await server.getLedgerEntries(key)
  if (!entries?.length) throw new Error(`${contractId} is not a deployed contract`)
  const exec = entries[0].val.contractData().val().instance().executable()
  if (exec.switch().name !== 'contractExecutableWasm') {
    throw new Error(`${contractId} is a built-in contract, not a wasm one`)
  }
  return exec.wasmHash()
}

async function submit(tx, signer, label) {
  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${label}: ${sim.error}`)
  const prepared = rpc.assembleTransaction(tx, sim).build()
  prepared.sign(signer)
  const sent = await server.sendTransaction(prepared)
  if (sent.status === 'ERROR') {
    throw new Error(`${label}: ${JSON.stringify(sent.errorResult)}`)
  }
  for (let i = 0; i < 40; i++) {
    const got = await server.getTransaction(sent.hash)
    if (got.status === 'SUCCESS') return { hash: sent.hash, result: got }
    if (got.status === 'FAILED') throw new Error(`${label}: transaction failed (${sent.hash})`)
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`${label}: timed out (${sent.hash})`)
}

// How long after expiry a position can still be settled: Reflector keeps about
// a day of history. Past it, a v4 position cannot settle at all.
const SETTLE_WINDOW_SECS = 86_400

/**
 * Unsettled positions on an instance, split into those that can still settle
 * and those past the oracle window.
 */
async function unsettledPositions(contractId) {
  const { next_id } = await read(contractId, 'stats', PROBE_ACCOUNT)
  const now = Math.floor(Date.now() / 1000)
  const live = []
  const stranded = []
  for (let id = 0n; id < BigInt(next_id); id++) {
    const p = await read(contractId, 'position', PROBE_ACCOUNT, nativeToScVal(id, { type: 'u64' }))
    if (p.settled) continue
    const row = { id: Number(id), expiry: new Date(Number(p.expiry) * 1000).toISOString() }
    if (Number(p.expiry) + SETTLE_WINDOW_SECS > now) live.push(row)
    else stranded.push(row)
  }
  return { live, stranded }
}

/** Whether `account` can receive what `sac` pays out. */
async function canReceive(account, sac) {
  const asset = await sacAsset(sac)
  if (!asset) return true // native, or a contract token with no classic asset
  const res = await fetch(
    `${HORIZON_URL}/accounts/${account}`,
  ).then((r) => (r.ok ? r.json() : null))
  if (!res) return false
  return res.balances.some(
    (b) => b.asset_code === asset.code && b.asset_issuer === asset.issuer,
  )
}

/** The classic asset a SAC wraps, read off the contract itself. */
async function sacAsset(sac) {
  try {
    const probe = await read(sac, 'name', PROBE_ACCOUNT)
    // SAC `name` is "CODE:ISSUER" for an issued asset, "native" for XLM.
    const [code, issuer] = String(probe).split(':')
    return issuer ? { code, issuer } : null
  } catch {
    return null
  }
}

async function preflight(vault, treasury, token, cash, probe) {
  console.log('\nbefore this book can trade:')
  const stats = await read(vault, 'stats', probe).catch(() => null)
  const pools = stats
    ? `cash ${Number(stats.cash_balance) / 1e7}, underlying ${Number(stats.underlying_balance) / 1e7}`
    : 'unreadable'
  console.log(`  pools      : ${pools}  (fund / fund_underlying — both one-way)`)
  // An assigned call sends the collateral to the treasury, and an issued asset
  // cannot be received without a trustline. On the XLM book this never came up:
  // assigned calls routed native XLM.
  console.log(
    `  treasury   : collateral ${(await canReceive(treasury, token)) ? 'receivable' : 'NOT RECEIVABLE — needs a trustline'}, ` +
      `cash ${(await canReceive(treasury, cash)) ? 'receivable' : 'NOT RECEIVABLE — needs a trustline'}`,
  )
}

async function main() {
  const symbol = (process.argv[2] ?? '').toUpperCase()
  const dryRun = process.argv.includes('--dry-run')
  // --check re-runs the post-deploy readiness read against the instance already
  // configured for this asset. The answers change as pools are funded and
  // trustlines opened, so it is worth being able to ask again.
  const checkOnly = process.argv.includes('--check')
  const wasmPath = flagValue('--wasm')
  if (!/^[A-Z0-9]{1,12}$/.test(symbol)) {
    console.error('usage: node scripts/deploy-vault.mjs <SYMBOL> [--dry-run] [--check] [--wasm <file>]')
    console.error('  SYMBOL is the book as declared in src/lib/assets/config.ts, e.g. BTC')
    process.exit(1)
  }
  const book = bookFromEnv(symbol)
  const replacing = process.env[vaultEnvKey(symbol)] || null

  if (checkOnly) {
    const live = process.env[vaultEnvKey(symbol)]
    if (!live) throw new Error(`no ${vaultEnvKey(symbol)} configured`)
    const cfg = await read(live, 'config', PROBE_ACCOUNT)
    console.log(`→ ${symbol} book:`, live, `(feed ${cfg.feed})`)
    console.log('  wasm hash  :', (await wasmHashOf(live)).toString('hex'))
    // v5 only: a raise the admin scheduled and that does not bind yet.
    const pending = await read(live, 'pending_limits', PROBE_ACCOUNT).catch(() => undefined)
    if (pending) {
      console.log(`  pending    : limit raise binds at ${new Date(Number(pending.effective_at) * 1000).toISOString()}`)
    }
    await preflight(live, cfg.treasury, cfg.token, cfg.cash, PROBE_ACCOUNT)
    return
  }

  const reference = process.env.NEXT_PUBLIC_VAULT_CONTRACT
  if (!reference) throw new Error('NEXT_PUBLIC_VAULT_CONTRACT must name the instance to copy the desk from')

  // Replacing a book's instance moves the settlement sweep off the old one:
  // it walks each book's configured vault and nothing else. Any position
  // there that can still settle would be left to run out its oracle window
  // unattended — finding 55 recreated by the migration. So the old instance
  // has to be drained first: halt quoting on the book (POST
  // /api/admin/circuit-breaker {"scope": "<SYMBOL>", "tripped": true}), let
  // the sweep settle what remains, then deploy.
  if (replacing) {
    const { live, stranded } = await unsettledPositions(replacing)
    console.log(`→ replacing  : ${replacing}`)
    if (stranded.length > 0) {
      console.log(`  stranded   : ${stranded.map((p) => `#${p.id} (expired ${p.expiry})`).join(', ')}`)
    }
    // Positions still open on the old instance are fine once it is retired:
    // the sweep walks every instance in VAULT_RETIRED_<SYMBOL> and settles them
    // where they were written. Without that entry they would be left behind.
    const retiredKey = `VAULT_RETIRED_${symbol}`
    const retired = (process.env[retiredKey] ?? '').split(',').map((s) => s.trim())
    const open = live.map((p) => `#${p.id} (expiry ${p.expiry})`).join(', ')
    if (live.length > 0 && !retired.includes(replacing)) {
      throw new Error(
        `${replacing} still has ${live.length} position(s) that can settle: ${open}.\n` +
          `  Add it to ${retiredKey} (here and on the app) so the sweep keeps settling them, ` +
          `or let them settle before replacing the instance.`,
      )
    }
    console.log(
      live.length > 0
        ? `  open       : ${open} — settled on the old instance via ${retiredKey}`
        : '  open       : none left to settle',
    )
  }
  if (!book.token) {
    throw new Error(`${symbol} has no collateral contract: set NEXT_PUBLIC_${symbol}_CONTRACT`)
  }
  if (book.missing.length > 0) {
    throw new Error(
      `${symbol} has no deploy limits: set ${book.missing.join(', ')}\n` +
        '  These are the contract\'s own caps, enforced for the life of the instance.',
    )
  }

  // The deployer only pays the fee and owns the contract-id preimage. The
  // admin is a constructor argument, not a signer here — which is just as well,
  // because the admin account is behind a 2-of-3 multisig and a single key
  // cannot source a transaction from it at all.
  // VAULT_DEPLOY_SECRET is for a machine without the Stellar CLI; otherwise the
  // key is read from the CLI's store by alias.
  const deployer = Keypair.fromSecret(
    process.env.VAULT_DEPLOY_SECRET || secretOf(process.env.VAULT_DEPLOY_KEY ?? 'lusty-runner'),
  )
  console.log('→ deployer   :', deployer.publicKey())

  const config = await read(reference, 'config', deployer.publicKey())
  const cash = book.cash ?? config.cash
  const quoters = await read(reference, 'quoters', deployer.publicKey())
  const referenceHash = await wasmHashOf(reference)
  const wasm = wasmPath ? readFileSync(wasmPath) : null
  let wasmHash = wasm ? createHash('sha256').update(wasm).digest() : referenceHash
  console.log('→ reference  :', reference, `(feed ${config.feed})`)
  console.log('  wasm hash  :', referenceHash.toString('hex'))
  if (wasm) {
    console.log(`→ new wasm   : ${wasmPath} (${wasm.length} bytes)`)
    console.log('  wasm hash  :', wasmHash.toString('hex'))
    if (wasmHash.equals(referenceHash)) console.log('  note       : same code the reference already runs')
  }
  console.log('  oracle     :', config.oracle)
  console.log('  treasury   :', config.treasury)
  console.log('  admin      :', config.admin)
  console.log('  quoters    :', quoters.join(', '))
  console.log(`→ new book   : feed ${book.feed}`)
  console.log('  token      :', book.token)
  console.log('  cash       :', cash)
  console.log('  limits     :', Object.fromEntries(
    Object.entries(book.limits).map(([k, v]) => [k, typeof v === 'bigint' ? `${Number(v) / 1e7}` : v])
  ))

  if (config.admin !== deployer.publicKey()) {
    // Expected, and worth printing rather than hiding: the new book's admin is
    // whoever the reference instance's is, and a book whose admin key nobody
    // holds can never have its limits tightened.
    console.log('  note       : admin is the reference instance\'s, not the deployer')
  }
  if (dryRun) {
    console.log('\n(dry run — nothing deployed)')
    return
  }

  if (wasm && !wasmHash.equals(referenceHash)) {
    // Uploading code that is already on the network is harmless; it costs the
    // fee and returns the same hash. Compare it anyway: the hash deployed from
    // must be the hash of the file that was read.
    console.log('→ uploading wasm')
    const upload = new TransactionBuilder(await server.getAccount(deployer.publicKey()), {
      fee: '10000000',
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(Operation.uploadContractWasm({ wasm }))
      .setTimeout(120)
      .build()
    const { hash: uploadTx, result } = await submit(upload, deployer, 'upload')
    const uploaded = Buffer.from(scValToNative(result.returnValue))
    if (!uploaded.equals(wasmHash)) {
      throw new Error(`upload returned hash ${uploaded.toString('hex')}, not the file's ${wasmHash.toString('hex')}`)
    }
    console.log('   tx:', uploadTx)
    wasmHash = uploaded
  }

  const args = [
    new Address(config.oracle).toScVal(),
    nativeToScVal(book.feed, { type: 'symbol' }),
    new Address(book.token).toScVal(),
    new Address(cash).toScVal(),
    new Address(config.treasury).toScVal(),
    nativeToScVal(quoters.map((q) => new Address(q)), { type: 'address' }),
    new Address(config.admin).toScVal(),
    limitsScVal(book.limits),
  ]

  console.log('→ deploying')
  const tx = new TransactionBuilder(await server.getAccount(deployer.publicKey()), {
    fee: '10000000',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.createCustomContract({
        address: new Address(deployer.publicKey()),
        wasmHash,
        constructorArgs: args,
      })
    )
    .setTimeout(120)
    .build()
  const { hash, result } = await submit(tx, deployer, 'deploy')
  const contractId = Address.fromScAddress(result.returnValue.address()).toString()
  console.log('   tx:', hash)

  // Read the instance back before claiming it exists. A constructor that ran
  // against the wrong feed is not visible in a successful transaction — it is
  // visible here, and nowhere else until a position settles against the wrong
  // price weeks later.
  const live = await read(contractId, 'config', deployer.publicKey())
  const liveLimits = await read(contractId, 'limits', deployer.publicKey())
  console.log('\n✓ deployed', contractId)
  console.log('  config :', live)
  console.log('  limits :', liveLimits)
  if (live.feed !== book.feed) throw new Error(`instance reads back feed ${live.feed}, not ${book.feed}`)
  if (live.token !== book.token) throw new Error('instance reads back a different collateral token')
  const running = await wasmHashOf(contractId)
  if (!running.equals(wasmHash)) throw new Error(`instance runs wasm ${running.toString('hex')}, not ${wasmHash.toString('hex')}`)

  // What is still not true about this book. All of it fails late — at
  // settlement, from inside a token contract — rather than at deploy, so it is
  // printed here with the state actually read rather than left to a checklist.
  await preflight(contractId, config.treasury, book.token, cash, deployer.publicKey())

  console.log('\npaste into .env.local:\n')
  console.log(`${vaultEnvKey(symbol)}=${contractId}`)
  if (process.env[vaultEnvKey(symbol)]) {
    // The instance it replaces keeps its positions, and the indexer and the
    // settlement runner only reach it if it is still listed.
    console.log(
      `\nand add the instance it replaces to VAULT_RETIRED_${symbol}, so it stays settled and indexed: ` +
        process.env[vaultEnvKey(symbol)],
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
