// Settle and pay out the retired distributor rail, once, from the operator side.
//
// The legacy book is what is left of the pre-contract design: collateral users
// paid to a server-held account, positions the server priced, and a payout the
// user had to come back and ask for. The payout route is closed by default
// (/api/vault/claim, LEGACY_CLAIM_ENABLED) because a server that can move user
// collateral is the trust assumption the contract migration removes. Closing
// the route did not settle the book, though — it froze it. This script finishes
// the wind-down deliberately instead of waiting for 200-odd wallets to return.
//
// It is not a refund. Every position is settled at the price of ITS OWN expiry
// minute, exactly as the claim route would have:
//
//   covered call: spot <= strike → return XLM collateral
//                 spot >  strike → pay LUSD = collateral × strike   (assigned)
//   cash-secured: spot >= strike → return LUSD collateral
//                 spot <  strike → pay XLM = collateral ÷ strike    (assigned)
//
// Returning collateral to an assigned writer would be a gift, not a settlement,
// and the on-chain record would not survive anyone checking it.
//
// Every row is verified against the chain before it is paid: the deposit
// transaction must exist, be sourced by the wallet claiming it, pay the
// distributor, and match the recorded amount. The database is a record, not an
// authority — the same principle the positions route states for contract
// positions applies here in the one place it still matters.
//
// Usage:
//   node scripts/legacy-wind-down.mjs plan          # read-only, writes the plan file
//   node scripts/legacy-wind-down.mjs execute       # sends payments, records them
//
// `plan` touches nothing. `execute` refuses to start unless a plan exists, the
// distributor can cover it, and PAY=yes is set in the environment.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import pg from 'pg'

const PLAN_FILE = 'scripts/.wind-down-plan.json'
const OPS_PER_TX = 90 // Stellar allows 100; leave room and stay under the fee cap.

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
)

const HORIZON = env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org'
const LUSD_CODE = env.NEXT_PUBLIC_LUSD_CODE ?? 'LUSD'
const LUSD_ISSUER = env.NEXT_PUBLIC_LUSD_ISSUER
const DISTRIBUTOR = env.NEXT_PUBLIC_LUSD_DISTRIBUTOR
const horizon = new Horizon.Server(HORIZON)
const lusd = new Asset(LUSD_CODE, LUSD_ISSUER)

const round7 = (n) => Math.floor(n * 1e7) / 1e7
const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

function db() {
  return new pg.Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.DB_SSL_REJECT_UNAUTHORIZED === 'false' ? { rejectUnauthorized: false } : undefined,
  })
}

/** The price at an expiry minute, pinned — never the price now. */
async function priceAt(ms) {
  const url =
    `https://api.binance.com/api/v3/klines?symbol=XLMUSDT&interval=1m` +
    `&startTime=${ms}&limit=1`
  const r = await fetch(url)
  if (!r.ok) return null
  const rows = await r.json()
  const close = Array.isArray(rows) && rows[0] ? parseFloat(rows[0][4]) : NaN
  return isFinite(close) && close > 0 ? close : null
}

async function plan() {
  const pool = db()
  const { rows } = await pool.query(`
    select t.tx_hash, t.address, t.subtype,
           (t.metadata->>'collateralAmount')::numeric as collateral,
           (t.metadata->>'strikePrice')::numeric      as strike,
           coalesce(
             (t.metadata->>'expiryIso')::timestamptz,
             t.created_at + ((t.metadata->>'daysToExpiry')::numeric * interval '1 day')
           ) as expiry
      from transactions t
      left join processed_actions pa
        on pa.action_type = 'claim' and pa.source_hash = t.tx_hash
     where t.type = 'deposit' and t.subtype in ('call','put')
       and not (t.metadata ? 'positionId') and pa.confirmed_at is null
     order by t.created_at`)
  await pool.end()
  console.log(`legacy rows outstanding: ${rows.length}`)

  // One price lookup per distinct expiry minute rather than per row.
  const minute = (d) => Math.floor(new Date(d).getTime() / 60000) * 60000
  const minutes = [...new Set(rows.filter((r) => r.expiry).map((r) => minute(r.expiry)))]
  const prices = new Map()
  for (const ms of minutes) prices.set(ms, await priceAt(ms))
  console.log(`expiry minutes priced: ${[...prices.values()].filter(Boolean).length}/${minutes.length}`)

  const payments = []
  const skipped = []
  let checked = 0

  for (const r of rows) {
    const collateral = Number(r.collateral)
    const strike = Number(r.strike)
    const reject = (why) => skipped.push({ tx: r.tx_hash, address: r.address, why })

    if (!(collateral > 0) || !(strike > 0) || !r.expiry) { reject('incomplete record'); continue }
    const spot = prices.get(minute(r.expiry))
    if (!spot) { reject('no price at expiry'); continue }
    if (new Date(r.expiry).getTime() > Date.now()) { reject('not yet expired'); continue }

    // The chain, not the database, decides whether this deposit happened.
    const tx = await horizon.transactions().transaction(r.tx_hash).call().catch(() => null)
    if (!tx || tx.source_account !== r.address) { reject('deposit tx missing or wrong source'); continue }
    const ops = await horizon.operations().forTransaction(r.tx_hash).call()
    const pay = ops.records.find((o) => o.type === 'payment')
    if (!pay || pay.to !== DISTRIBUTOR) { reject('deposit did not pay the distributor'); continue }
    if (Math.abs(parseFloat(pay.amount) - collateral) > 0.01) { reject('deposit amount mismatch'); continue }
    checked++

    const call = r.subtype === 'call'
    const assigned = call ? spot > strike : spot < strike
    const asset = call === !assigned ? 'XLM' : 'LUSD'
    const amount = call
      ? (assigned ? collateral * strike : collateral)
      : (assigned ? collateral / strike : collateral)

    payments.push({
      tx: r.tx_hash,
      address: r.address,
      side: r.subtype,
      outcome: assigned ? 'assigned' : 'kept',
      asset,
      amount: round7(amount),
      spot,
      strike,
      expiry: new Date(r.expiry).toISOString(),
    })
  }

  // A LUSD payout to a wallet with no trustline fails the whole transaction,
  // so those are separated now rather than discovered mid-batch.
  const lusdWallets = [...new Set(payments.filter((p) => p.asset === 'LUSD').map((p) => p.address))]
  const noTrustline = new Set()
  for (const w of lusdWallets) {
    const acc = await horizon.loadAccount(w).catch(() => null)
    const ok = acc?.balances.some(
      (b) => b.asset_code === LUSD_CODE && b.asset_issuer === LUSD_ISSUER
    )
    if (!ok) noTrustline.add(w)
  }
  const payable = payments.filter((p) => !(p.asset === 'LUSD' && noTrustline.has(p.address)))
  for (const p of payments) {
    if (p.asset === 'LUSD' && noTrustline.has(p.address)) {
      skipped.push({ tx: p.tx, address: p.address, why: 'no LUSD trustline' })
    }
  }

  const total = (asset) =>
    payable.filter((p) => p.asset === asset).reduce((s, p) => s + p.amount, 0)
  // Spendable, not held. A balance is not available in full: the DEX offers
  // that back the swap feature lock part of it as a selling liability, and the
  // account's own reserve locks a little more. Comparing the gross balance
  // against the bill passes a plan that then dies mid-batch on op_underfunded.
  const acc = await horizon.loadAccount(DISTRIBUTOR)
  const spendable = (code) => {
    const b = acc.balances.find((x) =>
      code === 'XLM' ? x.asset_type === 'native' : x.asset_code === code
    )
    if (!b) return 0
    const reserve = code === 'XLM' ? (2 + acc.subentry_count) * 0.5 : 0
    return parseFloat(b.balance) - parseFloat(b.selling_liabilities ?? '0') - reserve
  }
  const held = spendable

  const summary = {
    rows: rows.length,
    verifiedOnChain: checked,
    payable: payable.length,
    skipped: skipped.length,
    outcomes: {
      callKept: payable.filter((p) => p.side === 'call' && p.outcome === 'kept').length,
      callAssigned: payable.filter((p) => p.side === 'call' && p.outcome === 'assigned').length,
      putKept: payable.filter((p) => p.side === 'put' && p.outcome === 'kept').length,
      putAssigned: payable.filter((p) => p.side === 'put' && p.outcome === 'assigned').length,
    },
    owed: { XLM: total('XLM'), LUSD: total('LUSD') },
    held: { XLM: held('XLM'), LUSD: held(LUSD_CODE) },
  }
  summary.shortfall = {
    XLM: Math.max(0, summary.owed.XLM - summary.held.XLM + 5),
    LUSD: Math.max(0, summary.owed.LUSD - summary.held.LUSD),
  }

  writeFileSync(PLAN_FILE, JSON.stringify({ summary, payable, skipped }, null, 2))

  console.log('\n--- plan ---')
  console.log(`verified on chain : ${checked}/${rows.length}`)
  console.log(`payable           : ${payable.length}   skipped: ${skipped.length}`)
  console.log(`outcomes          :`, summary.outcomes)
  console.log(`owed              : ${fmt(summary.owed.XLM)} XLM + ${fmt(summary.owed.LUSD)} LUSD`)
  console.log(`distributor holds : ${fmt(summary.held.XLM)} XLM + ${fmt(summary.held.LUSD)} LUSD`)
  console.log(
    summary.shortfall.XLM || summary.shortfall.LUSD
      ? `SHORTFALL         : ${fmt(summary.shortfall.XLM)} XLM + ${fmt(summary.shortfall.LUSD)} LUSD — fund before executing`
      : `coverage          : sufficient`
  )
  if (skipped.length) {
    const why = {}
    for (const s of skipped) why[s.why] = (why[s.why] ?? 0) + 1
    console.log('skipped reasons   :', why)
  }
  console.log(`\nplan written to ${PLAN_FILE}`)
}

async function execute() {
  if (!existsSync(PLAN_FILE)) throw new Error('no plan — run `plan` first')
  const { summary, payable } = JSON.parse(readFileSync(PLAN_FILE, 'utf8'))
  if (process.env.PAY !== 'yes') throw new Error('refusing to send: set PAY=yes')
  if (summary.shortfall.XLM > 0 || summary.shortfall.LUSD > 0) {
    throw new Error(
      `refusing to send: short ${fmt(summary.shortfall.XLM)} XLM / ` +
      `${fmt(summary.shortfall.LUSD)} LUSD. A partial run pays whoever sorts first.`
    )
  }

  const secret = env.LUSD_DISTRIBUTOR_SECRET
  if (!secret) throw new Error('LUSD_DISTRIBUTOR_SECRET missing from .env.local')
  const signer = Keypair.fromSecret(secret)

  const pool = db()
  const sent = []
  const failed = []

  for (let i = 0; i < payable.length; i += OPS_PER_TX) {
    const batch = payable.slice(i, i + OPS_PER_TX)
    const account = await horizon.loadAccount(signer.publicKey())
    const builder = new TransactionBuilder(account, {
      fee: String(Number(BASE_FEE) * 10),
      networkPassphrase: Networks.TESTNET,
    })
    for (const p of batch) {
      builder.addOperation(
        Operation.payment({
          destination: p.address,
          asset: p.asset === 'XLM' ? Asset.native() : lusd,
          amount: p.amount.toFixed(7),
        })
      )
    }
    const tx = builder.setTimeout(120).build()
    tx.sign(signer)

    try {
      const res = await horizon.submitTransaction(tx)
      console.log(`batch ${i / OPS_PER_TX + 1}: ${batch.length} payments — ${res.hash}`)
      // Recorded per row so a second run, or the claim route if it is ever
      // reopened, cannot pay the same deposit twice.
      for (const p of batch) {
        await pool.query(
          `insert into processed_actions (action_type, source_hash, confirmed_at, payout_hash)
           values ('claim', $1, now(), $2)
           on conflict (action_type, source_hash) do update
             set confirmed_at = excluded.confirmed_at,
                 payout_hash  = excluded.payout_hash`,
          [p.tx, res.hash]
        )
        sent.push({ ...p, payoutHash: res.hash })
      }
    } catch (e) {
      const detail = e?.response?.data?.extras?.result_codes ?? e?.message
      console.error(`batch ${i / OPS_PER_TX + 1} FAILED:`, JSON.stringify(detail))
      failed.push(...batch.map((p) => ({ ...p, error: JSON.stringify(detail) })))
    }
  }

  await pool.end()
  writeFileSync('scripts/.wind-down-receipt.json', JSON.stringify({ sent, failed }, null, 2))
  console.log(`\nsent ${sent.length}, failed ${failed.length} — receipt written`)
}

const mode = process.argv[2]
if (mode === 'plan') await plan()
else if (mode === 'execute') await execute()
else {
  console.log('usage: node scripts/legacy-wind-down.mjs plan|execute')
  process.exit(1)
}
