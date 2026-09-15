// Deploy a vault instance for one underlying.
//
//   node scripts/deploy-vault.mjs BTC
//   node scripts/deploy-vault.mjs BTC --dry-run
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

// What each underlying's instance is constructed with.
//
// The caps are the contract's own: trustless, enforced on every write, and
// deliberately the outer bound rather than the operating envelope. The tighter
// figures the desk actually quotes live in the app (VAULT_*_CAP_*).
//
// Whatever is set here has to be copied into the book's `onchainLimits` in
// src/lib/assets.ts, which is what src/lib/vault-limits.ts reconciles the
// instance against before anything is quoted. Deploying one and forgetting the
// other takes the book offline, on purpose: two records of one rule that
// nobody compares is how a limit stops being in force without anyone noticing.
const BOOKS = {
  BTC: {
    feed: process.env.REFLECTOR_FEED_SYMBOL_BTC ?? 'BTC',
    token: process.env.NEXT_PUBLIC_BTC_CONTRACT,
    // Null means "whatever the reference instance settles in". Every book on
    // this desk pays premiums in the same cash today, and reading it off the
    // live instance is stronger than reading it off a local file that may
    // disagree with what XLM is actually escrowing against.
    cash: process.env.NEXT_PUBLIC_LUSD_CONTRACT ?? null,
    limits: {
      // 0.05 BTC a position, 5 BTC across one expiry. The app spreads its own
      // monthly capacity of 5 BTC across the three expiries it keeps open, so
      // it quotes at most 1.667 against a date the contract would take 5 on.
      // The contract is the looser of the two by design, and it is the one
      // that binds. Sized in BTC, not ported from XLM: XLM's 10,000 would read
      // as 10,000 BTC.
      max_position_call: stroops(0.05),
      max_expiry_call: stroops(5),
      // Puts escrow cash, so their caps are in LUSD: $1,500 a position and
      // $150,000 across an expiry.
      max_position_put: stroops(1_500),
      max_expiry_put: stroops(150_000),
      // Same premium ceiling as the XLM book. It bounds the quoter, not the
      // market, so there is nothing asset-specific in it.
      max_premium_bps: 2000,
    },
  },
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

/** Read a function off a deployed instance without sending anything. */
async function read(contractId, fn, probe) {
  const tx = new TransactionBuilder(await server.getAccount(probe), {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(fn))
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
  const book = BOOKS[symbol]
  if (!book) {
    console.error(`usage: node scripts/deploy-vault.mjs <${Object.keys(BOOKS).join('|')}> [--dry-run]`)
    process.exit(1)
  }

  if (checkOnly) {
    const live = process.env[`NEXT_PUBLIC_VAULT_CONTRACT_${symbol}`]
    if (!live) throw new Error(`no NEXT_PUBLIC_VAULT_CONTRACT_${symbol} configured`)
    const cfg = await read(live, 'config', PROBE_ACCOUNT)
    console.log(`→ ${symbol} book:`, live, `(feed ${cfg.feed})`)
    await preflight(live, cfg.treasury, cfg.token, cfg.cash, PROBE_ACCOUNT)
    return
  }

  const reference = process.env.NEXT_PUBLIC_VAULT_CONTRACT
  if (!reference) throw new Error('NEXT_PUBLIC_VAULT_CONTRACT must name the instance to copy the desk from')
  if (!book.token) throw new Error(`${symbol} has no collateral contract configured`)

  // The deployer only pays the fee and owns the contract-id preimage. The
  // admin is a constructor argument, not a signer here — which is just as well,
  // because the admin account is behind a 2-of-3 multisig and a single key
  // cannot source a transaction from it at all.
  const deployer = Keypair.fromSecret(secretOf(process.env.VAULT_DEPLOY_KEY ?? 'lusty-runner'))
  console.log('→ deployer   :', deployer.publicKey())

  const config = await read(reference, 'config', deployer.publicKey())
  const cash = book.cash ?? config.cash
  const quoters = await read(reference, 'quoters', deployer.publicKey())
  const wasmHash = await wasmHashOf(reference)
  console.log('→ reference  :', reference, `(feed ${config.feed})`)
  console.log('  wasm hash  :', wasmHash.toString('hex'))
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

  // What is still not true about this book. All of it fails late — at
  // settlement, from inside a token contract — rather than at deploy, so it is
  // printed here with the state actually read rather than left to a checklist.
  await preflight(contractId, config.treasury, book.token, cash, deployer.publicKey())

  console.log('\npaste into .env.local:\n')
  console.log(`NEXT_PUBLIC_VAULT_CONTRACT_${symbol}=${contractId}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
