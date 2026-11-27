// The backup settlement runner.
//
//   node scripts/settle-due.mjs              settle what the primary left due
//   node scripts/settle-due.mjs --dry-run    list it, sign nothing
//
// Runs from a host other than the application's — the scheduled workflow in
// .github/workflows/backup-settle.yml — and signs with its own fee key,
// BACKUP_SETTLE_SECRET, never the primary's. The key needs no privilege:
// `settle` and `record_price` are permissionless, pay the position's owner,
// and cost the caller only the fee.
//
// The vaults are the release manifest's books (release/<network>.json), plus
// any in BACKUP_SETTLE_EXTRA_VAULTS (comma-separated) for retired instances
// that still hold open positions. A position is settled once it has been
// expired for BACKUP_SETTLE_GRACE_MINUTES (default 60): the primary sweeps
// every fifteen minutes, so in the normal case it has settled everything first.
//
// Exit 0 when nothing failed, 1 when a settle or a read failed (the workflow
// run turns red), 2 when it is not configured to run. On a clean run it pings
// BACKUP_SETTLE_HEARTBEAT_URL if set, so a backup that has stopped running is
// itself an alert.

import { readFileSync } from 'node:fs'
import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk'
import { NETWORK, PASSPHRASE, RPC_URL } from './lib/network.mjs'
import { runBackup } from './lib/backup-settle.mjs'

const dryRun = process.argv.includes('--dry-run')
const graceMinutes = Number(process.env.BACKUP_SETTLE_GRACE_MINUTES ?? 60)
const secret = process.env.BACKUP_SETTLE_SECRET ?? ''

if (!dryRun && !secret) {
  console.error('BACKUP_SETTLE_SECRET is not set; run with --dry-run to list what is due without signing.')
  process.exit(2)
}
if (!Number.isFinite(graceMinutes) || graceMinutes < 0) {
  console.error(`BACKUP_SETTLE_GRACE_MINUTES is "${process.env.BACKUP_SETTLE_GRACE_MINUTES}"; expected minutes.`)
  process.exit(2)
}

const manifestPath = `release/${NETWORK.name}.json`
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.network !== NETWORK.name) {
  console.error(`${manifestPath} is for ${manifest.network}; NEXT_PUBLIC_STELLAR_NETWORK is ${NETWORK.name}.`)
  process.exit(2)
}
const extra = (process.env.BACKUP_SETTLE_EXTRA_VAULTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const vaults = [...new Set([...Object.values(manifest.books).map((b) => b.vault), ...extra])]

const server = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith('http://') })
const signer = secret ? Keypair.fromSecret(secret) : null
// Simulation needs a well-formed source account, not a funded one.
const PROBE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'

async function read(vault, method, ...args) {
  const tx = new TransactionBuilder(new Account(PROBE, '0'), { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(vault).call(method, ...args))
    .setTimeout(30)
    .build()
  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${method}: ${sim.error}`)
  return sim.result?.retval ? scValToNative(sim.result.retval) : undefined
}

async function invoke(vault, method, ...args) {
  const tx = new TransactionBuilder(await server.getAccount(signer.publicKey()), {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new Contract(vault).call(method, ...args))
    .setTimeout(180)
    .build()
  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${method}: ${sim.error}`)
  const prepared = rpc.assembleTransaction(tx, sim).build()
  prepared.sign(signer)
  const sent = await server.sendTransaction(prepared)
  if (sent.status === 'ERROR') throw new Error(`${method} rejected: ${JSON.stringify(sent.errorResult)}`)
  for (let i = 0; i < 30; i++) {
    const got = await server.getTransaction(sent.hash)
    if (got.status === 'SUCCESS') {
      return { hash: sent.hash, value: got.returnValue ? scValToNative(got.returnValue) : undefined }
    }
    if (got.status === 'FAILED') throw new Error(`${method} failed on chain: ${sent.hash}`)
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`${method} not confirmed in time: ${sent.hash}`)
}

const u64 = (v) => nativeToScVal(BigInt(v), { type: 'u64' })

const report = await runBackup({
  vaults,
  nextId: async (vault) => Number((await read(vault, 'stats')).next_id),
  readPosition: async (vault, id) => {
    const p = await read(vault, 'position', u64(id))
    return { settled: Boolean(p.settled), expiry: p.expiry }
  },
  settle: signer
    ? async (vault, id) => {
        const r = await invoke(vault, 'settle', u64(id))
        return { hash: r.hash, outcome: String(r.value) }
      }
    : null,
  recordPrice: async (vault, expiry) => {
    if (!signer) return 'unsupported'
    let held
    try {
      held = await read(vault, 'recorded_price', u64(expiry))
    } catch {
      return 'unsupported' // a v4 instance has no recorded prices
    }
    if (held !== undefined && held !== null) return 'already'
    await invoke(vault, 'record_price', u64(expiry))
    return 'recorded'
  },
  nowSecs: Math.floor(Date.now() / 1000),
  graceSecs: graceMinutes * 60,
})

const short = (v) => `${v.slice(0, 6)}…${v.slice(-4)}`
for (const v of report.vaults) console.log(`${short(v.vault)}: ${v.positions} positions, ${v.due} past grace`)
for (const d of report.due) {
  const s = report.settled.find((x) => x.vault === d.vault && x.id === d.id)
  console.log(
    `  #${d.id} on ${short(d.vault)} expired ${new Date(d.expiry * 1000).toISOString()}` +
      (dryRun ? ' — due' : s ? ` — settled ${s.outcome} ${s.hash}` : ' — not settled'),
  )
}
for (const p of report.pricesRecorded) console.log(`  price recorded for ${short(p.vault)} at ${new Date(p.expiry * 1000).toISOString()}`)
for (const f of [...report.failed, ...report.readErrors]) console.error(`  FAILED ${JSON.stringify(f)}`)
console.log(
  `${NETWORK.name}${dryRun ? ' (dry run)' : ''}: ${report.due.length} due, ${report.settled.length} settled, ` +
    `${report.failed.length} failed, ${report.readErrors.length} unreadable`,
)

const clean = report.failed.length === 0 && report.readErrors.length === 0
if (clean && !dryRun && process.env.BACKUP_SETTLE_HEARTBEAT_URL) {
  try {
    const r = await fetch(process.env.BACKUP_SETTLE_HEARTBEAT_URL, { signal: AbortSignal.timeout(5000) })
    if (!r.ok) console.warn(`heartbeat answered ${r.status}`)
  } catch (e) {
    console.warn(`heartbeat failed: ${e?.message ?? e}`)
  }
}
process.exit(clean ? 0 : 1)
