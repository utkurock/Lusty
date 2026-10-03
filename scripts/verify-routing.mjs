// End-to-end testnet verification for liquidity routing.
//
// Drives the application's own route — POST /api/routing/swap on a running
// server — rather than re-implementing it, so what is verified is the code
// the earn screen calls: the allowlist, the par bound, the quote, the in-flight
// reservation, the send maximum, and the settle that reads the fill back from
// the ledger. The writer's key signs here the way their wallet would.
//
//   node scripts/verify-routing.mjs fund <usdc>      # trustline + USDC from the distributor
//   node scripts/verify-routing.mjs swap <lusd>      # one routed USDC -> LUSD swap
//   node scripts/verify-routing.mjs refuse           # the three refusals, recorded
//                                                    (withdraws and restores the direct offer)
//
// Then open a put with exactly the routed cash:
//   node scripts/verify-lifecycle.mjs XLM put <lusd>
//
// BASE_URL picks the server (default http://localhost:3999, a local
// `next start`). The route's reservation and journal live in that process, so
// prepare and settle have to reach the same one.

import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { execFileSync } from 'node:child_process'

try {
  process.loadEnvFile('.env.local')
} catch {
  // Rely on an already-exported environment.
}

const HORIZON = process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org'
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3999'
const LUSD = new Asset(
  'LUSD',
  process.env.NEXT_PUBLIC_LUSD_ISSUER ?? 'GBCMRD6NDL2RAJUOFQ25EHZVO3IRIGNESWE4QDRFB4AVFIP7IT5BRCJ6',
)
const USDC = new Asset(
  process.env.NEXT_PUBLIC_ANCHOR_ASSET_CODE ?? 'USDC',
  process.env.NEXT_PUBLIC_ANCHOR_ASSET_ISSUER ??
    'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
)

const secretOf = (alias) =>
  execFileSync('stellar', ['keys', 'show', alias], { encoding: 'utf8' }).trim()
const writer = Keypair.fromSecret(secretOf('lusty-writer'))
const horizon = new Horizon.Server(HORIZON)

const [, , cmd, arg] = process.argv

function balances(account) {
  const of = (asset) =>
    account.balances.find((b) => b.asset_code === asset.code && b.asset_issuer === asset.issuer)
  return { usdc: of(USDC), lusd: of(LUSD) }
}

async function show(label) {
  const { usdc, lusd } = balances(await horizon.loadAccount(writer.publicKey()))
  console.log(`  ${label.padEnd(8)} USDC ${usdc?.balance ?? 'no trustline'} · LUSD ${lusd?.balance ?? 'no trustline'}`)
}

async function send(tx, signer, label) {
  tx.sign(signer)
  try {
    const res = await horizon.submitTransaction(tx)
    console.log(`  ${label.padEnd(34)} ${res.hash}`)
    return { ok: true, hash: res.hash }
  } catch (e) {
    const data = e?.response?.data
    const codes = data?.extras?.result_codes
    // A transaction that fails while being applied is still in the ledger, fee
    // charged; Horizon's error does not always carry its hash, so it is
    // computed here and looked up rather than lost.
    const hash = data?.extras?.hash ?? tx.hash().toString('hex')
    const onLedger = await horizon.transactions().transaction(hash).call().then(() => true, () => false)
    console.log(`  ${label.padEnd(34)} on ledger: ${onLedger}`)
    console.log(`  ${label.padEnd(34)} REFUSED ${JSON.stringify(codes ?? e?.message)}${hash ? `  ${hash}` : ''}`)
    return { ok: false, codes, hash }
  }
}

async function api(body) {
  const res = await fetch(`${BASE_URL}/api/routing/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function fund(amount) {
  const distributor = Keypair.fromSecret(process.env.LUSD_DISTRIBUTOR_SECRET)
  const account = await horizon.loadAccount(writer.publicKey())
  if (!balances(account).usdc) {
    await send(
      new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
        .addOperation(Operation.changeTrust({ asset: USDC }))
        .setTimeout(120)
        .build(),
      writer,
      'writer USDC trustline',
    )
  }
  await send(
    new TransactionBuilder(await horizon.loadAccount(distributor.publicKey()), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.payment({ destination: writer.publicKey(), asset: USDC, amount: amount.toFixed(7) }))
      .setTimeout(120)
      .build(),
    distributor,
    `distributor → writer ${amount} USDC`,
  )
  await show('after')
}

async function swap(amount) {
  await show('before')
  const prepared = await api({ action: 'prepare', address: writer.publicKey(), asset: 'XLM', destAmount: amount })
  if (!prepared.body?.ok) {
    throw new Error(`prepare refused (${prepared.status}): ${JSON.stringify(prepared.body)}`)
  }
  const { id, xdr, quoted, sendMax } = prepared.body
  console.log(`  prepared ${id}: ${amount} LUSD quoted at ${quoted} USDC, sendMax ${sendMax}`)

  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET)
  const sent = await send(tx, writer, `routed swap ${amount} LUSD`)
  const settled = await api(
    sent.ok ? { action: 'settle', id, txHash: sent.hash } : { action: 'settle', id, reason: JSON.stringify(sent.codes) },
  )
  console.log(`  settle: ${JSON.stringify(settled.body)}`)
  await show('after')
}

async function refuse() {
  // 1. Min-output is the network's, not ours: the same strict-receive payment
  //    with a send maximum below the book's price fails on the ledger and moves
  //    nothing but the fee. Built by hand because the route will never derive a
  //    maximum this tight — that is the point of deriving it.
  await show('before')
  const account = await horizon.loadAccount(writer.publicKey())
  await send(
    new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(
        Operation.pathPaymentStrictReceive({
          sendAsset: USDC,
          sendMax: '9.9000000',
          destination: writer.publicKey(),
          destAsset: LUSD,
          destAmount: '10.0000000',
          path: [],
        }),
      )
      .setTimeout(120)
      .build(),
    writer,
    'min-output: 10 LUSD for at most 9.9',
  )
  await show('after')

  // 2. Above the per-swap ceiling: refused before anything is built.
  const big = await api({ action: 'prepare', address: writer.publicKey(), asset: 'XLM', destAmount: 20_000 })
  console.log(`  prepare 20000 LUSD → ${big.status} ${big.body?.code}: ${big.body?.error}`)

  // 3. Off the allowlist, live. With the direct offer withdrawn the only path
  //    the finder has runs through XLM, which the direct-only route refuses
  //    before building anything. The offer goes straight back afterwards.
  const seed = (amount) =>
    execFileSync('node', ['scripts/seed-route-liquidity.mjs', '--amount', String(amount)], { encoding: 'utf8' })
  console.log('  ' + seed(0).trim().split('\n')[0])
  try {
    const hop = await api({ action: 'prepare', address: writer.publicKey(), asset: 'XLM', destAmount: 10 })
    console.log(`  prepare 10 LUSD, no direct book → ${hop.status} ${hop.body?.code}: ${hop.body?.error}`)
  } finally {
    console.log('  ' + seed(100_000).trim().split('\n')[0])
  }
}

if (cmd === 'fund') await fund(Number(arg ?? 30))
else if (cmd === 'swap') await swap(Number(arg ?? 20))
else if (cmd === 'refuse') await refuse()
else {
  console.error('usage: node scripts/verify-routing.mjs <fund|swap|refuse> [amount]')
  process.exit(1)
}
