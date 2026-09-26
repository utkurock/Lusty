// Read a deployed book's whole state, with no key and no permission.
//
//   node scripts/reproduce/read.mjs XLM
//   node scripts/reproduce/read.mjs BTC
//   node scripts/reproduce/read.mjs BTC 3        # also position #3
//
// This is the first thing to run against the adversarial window: every number
// the vault enforces against, read off the chain rather than off a page that
// says what it is. Nothing here is submitted, nothing is signed, and the only
// account named is a probe that simulation requires to exist.
//
// The solvency line at the end is the contract's own invariant, computed here
// from the same figures it computes it from. If it ever fails, that is a
// Critical finding on its own and needs no further exploit.
//
// Addresses come from the environment when it is set and from
// docs/DEPLOYMENTS.md otherwise, so this runs against a checkout with no
// .env.local at all.

import { Contract, Networks, TransactionBuilder, BASE_FEE, nativeToScVal, scValToNative, rpc } from '@stellar/stellar-sdk'

try {
  process.loadEnvFile('.env.local')
} catch {
  // Nothing local: fall through to the published addresses below.
}

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? 'https://soroban-testnet.stellar.org'
const PASSPHRASE = Networks.TESTNET
// Reads are simulated, never sent, so this account only has to exist.
const PROBE = 'GCXVANOIFHM7IAAZTDEEOYW7WUDO7ETVJYVEO74LA23JSXQJP4TAJVUX'
const server = new rpc.Server(RPC_URL)

// The published instances (docs/DEPLOYMENTS.md), overridable so this works
// against a deployment of your own.
const VAULTS = {
  XLM:
    process.env.NEXT_PUBLIC_VAULT_CONTRACT ||
    'CBJZGTCF2PJVHX2BNFTFZ2L2LX6DWD5JMTLHNCVYTSOD3BLVSXZRUCJZ',
  BTC:
    process.env.NEXT_PUBLIC_VAULT_CONTRACT_BTC ||
    'CBQEACXAOZMCU3YOUWDC3MWXDSQBWKNGKBA6XMRPY5D5JQRNP2HLMVEU',
}

const UNIT = 1e7
const ORACLE = 1e14
const amount = (v) => Number(v) / UNIT
const price = (v) => Number(v) / ORACLE
const fixed = (n, d = 7) => n.toFixed(d).replace(/0+$/, '').replace(/\.$/, '')

async function read(contractId, method, args = []) {
  const account = await server.getAccount(PROBE)
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build()
  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${method}: ${sim.error}`)
  return scValToNative(sim.result.retval)
}

/** Friday 08:00 UTC expiries the books keep open — the dates exposure is asked for. */
function openExpiries(count = 3, minDays = 2, tenorDays = 7, from = new Date()) {
  const d = new Date(from)
  d.setUTCHours(8, 0, 0, 0)
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1)
  while ((d.getTime() - from.getTime()) / 86400000 < minDays) {
    d.setUTCDate(d.getUTCDate() + tenorDays)
  }
  return Array.from({ length: count }, (_, i) => {
    const e = new Date(d)
    e.setUTCDate(e.getUTCDate() + i * tenorDays)
    return e
  })
}

async function main() {
  const symbol = (process.argv[2] ?? '').toUpperCase()
  const positionId = process.argv[3]
  const vault = VAULTS[symbol]
  if (!vault) {
    console.error(`usage: node scripts/reproduce/read.mjs <${Object.keys(VAULTS).join('|')}> [positionId]`)
    process.exit(1)
  }

  console.log(`\n${symbol} book — ${vault}`)
  console.log(`  rpc: ${RPC_URL}\n`)

  const [config, quoters, limits, stats] = await Promise.all([
    read(vault, 'config'),
    read(vault, 'quoters'),
    read(vault, 'limits'),
    read(vault, 'stats'),
  ])

  console.log('config()')
  for (const k of ['oracle', 'feed', 'token', 'cash', 'treasury', 'admin']) {
    console.log(`  ${k.padEnd(9)} ${config[k]}`)
  }
  console.log(`  quoters   ${quoters.join(', ')}`)

  console.log('\nlimits()  — the contract\'s own bounds, enforced on every write')
  console.log(`  position  call ${fixed(amount(limits.max_position_call))}  put ${fixed(amount(limits.max_position_put))}`)
  console.log(`  expiry    call ${fixed(amount(limits.max_expiry_call))}  put ${fixed(amount(limits.max_expiry_put))}`)
  console.log(`  premium   ${limits.max_premium_bps} bps of collateral, valued at the oracle price`)

  const s = {
    escrowedCall: amount(stats.escrowed_call),
    escrowedPut: amount(stats.escrowed_put),
    owedCall: amount(stats.owed_call),
    owedPut: amount(stats.owed_put),
    cash: amount(stats.cash_balance),
    underlying: amount(stats.underlying_balance),
    nextId: Number(stats.next_id),
  }
  console.log('\nstats()')
  console.log(`  escrowed  call ${fixed(s.escrowedCall)} ${symbol}   put ${fixed(s.escrowedPut)} cash`)
  console.log(`  owed      call ${fixed(s.owedCall)} cash   put ${fixed(s.owedPut)} ${symbol}`)
  console.log(`  balance   ${fixed(s.underlying)} ${symbol}   ${fixed(s.cash)} cash`)
  console.log(`  next id   ${s.nextId}   (ids restart at 0 in every instance)`)

  // The invariant the contract holds itself to, per leg:
  //   balance(payout) − escrowed(opposite) ≥ owed(kind)
  // A call pays cash and a put escrows cash, so they share the cash balance;
  // a put pays the underlying and a call escrows it. Neither leg may dip into
  // what the other leg is holding for somebody else.
  const cashFree = s.cash - s.escrowedPut
  const underFree = s.underlying - s.escrowedCall
  console.log('\nsolvency  — balance(payout) − escrowed(opposite) ≥ owed(kind)')
  console.log(
    `  calls     ${fixed(cashFree)} cash free vs ${fixed(s.owedCall)} owed   ` +
      (cashFree + 1e-9 >= s.owedCall ? 'OK' : '*** BROKEN ***'),
  )
  console.log(
    `  puts      ${fixed(underFree)} ${symbol} free vs ${fixed(s.owedPut)} owed   ` +
      (underFree + 1e-9 >= s.owedPut ? 'OK' : '*** BROKEN ***'),
  )

  console.log('\nexposure(kind, expiry)  — how full each open date is')
  for (const expiry of openExpiries()) {
    const secs = nativeToScVal(BigInt(Math.floor(expiry.getTime() / 1000)), { type: 'u64' })
    const [call, put] = await Promise.all([
      read(vault, 'exposure', [nativeToScVal(0, { type: 'u32' }), secs]),
      read(vault, 'exposure', [nativeToScVal(1, { type: 'u32' }), secs]),
    ])
    const pct = (used, cap) => (cap > 0 ? `${((used / cap) * 100).toFixed(1)}%` : '—')
    const c = amount(call)
    const p = amount(put)
    console.log(
      `  ${expiry.toISOString().slice(0, 10)}  call ${fixed(c).padStart(12)} ` +
        `(${pct(c, amount(limits.max_expiry_call))})   put ${fixed(p).padStart(12)} ` +
        `(${pct(p, amount(limits.max_expiry_put))})`,
    )
  }

  if (positionId !== undefined) {
    const raw = await read(vault, 'position', [
      nativeToScVal(BigInt(positionId), { type: 'u64' }),
    ])
    console.log(`\nposition(${positionId})`)
    console.log(`  owner     ${raw.owner}`)
    console.log(`  side      ${Number(raw.kind) === 0 ? 'call' : 'put'}`)
    console.log(`  collateral ${fixed(amount(raw.amount))}`)
    console.log(`  strike    $${price(raw.strike).toFixed(4)}`)
    console.log(`  expiry    ${new Date(Number(raw.expiry) * 1000).toISOString()}`)
    console.log(`  premium   ${fixed(amount(raw.premium))} cash`)
    console.log(`  settled   ${raw.settled}   outcome ${raw.outcome}`)
  }

  console.log()
}

main().catch((e) => {
  console.error(e.message ?? e)
  process.exit(1)
})
