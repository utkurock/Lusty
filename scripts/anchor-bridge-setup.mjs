// Stock the anchor bridge.
//
//   node scripts/anchor-bridge-setup.mjs            # trustline only
//   node scripts/anchor-bridge-setup.mjs --deposits 8
//
// The bridge in app/api/anchor/bridge trades the anchor's asset against LUSD
// one for one, out of the LUSD distributor. For that the distributor needs two
// things it does not have by default: a trustline in the anchor's asset, and a
// float of it to pay out when somebody crosses the other way.
//
// The trustline is one transaction. The float is the interesting part: nobody
// can mint the anchor's asset, because its issuer belongs to the anchor. So
// this buys it the way a user would — by running the anchor's own on-ramp with
// the distributor's key, once per deposit limit, and playing the sandbox bank
// each time. On mainnet this step is a real treasury operation, not a script.

import fs from 'fs'
import path from 'path'
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
const HOME_DOMAIN = process.env.NEXT_PUBLIC_ANCHOR_HOME_DOMAIN ?? 'tr-mock-anchor.fly.dev'
const ASSET_CODE = process.env.NEXT_PUBLIC_ANCHOR_ASSET_CODE ?? 'USDC'
const DIST_SECRET = process.env.LUSD_DISTRIBUTOR_SECRET

if (!DIST_SECRET) {
  console.error('missing LUSD_DISTRIBUTOR_SECRET in .env.local')
  process.exit(1)
}

const deposits = Number(
  process.argv.includes('--deposits')
    ? process.argv[process.argv.indexOf('--deposits') + 1]
    : 0
)

const server = new Horizon.Server(HORIZON)
const distributor = Keypair.fromSecret(DIST_SECRET)
const PUB = distributor.publicKey()
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function json(url, init) {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error ?? `${url} -> ${res.status}`)
  return body
}

/** SEP-1: everything else is discovered from here. */
async function discover() {
  const text = await (await fetch(`https://${HOME_DOMAIN}/.well-known/stellar.toml`)).text()
  const read = key => text.match(new RegExp(`^${key}="(.*)"`, 'm'))?.[1]
  const block = text.split('[[CURRENCIES]]').find(b => b.includes(`code="${ASSET_CODE}"`))
  const issuer = block?.match(/issuer="(.*)"/)?.[1]
  if (!issuer) throw new Error(`${HOME_DOMAIN} does not list ${ASSET_CODE}`)
  return {
    issuer,
    auth: read('WEB_AUTH_ENDPOINT'),
    transfer: read('TRANSFER_SERVER')?.replace(/\/$/, ''),
  }
}

/** SEP-10, signed with the distributor's key. */
async function login(auth) {
  const challenge = await json(`${auth}?account=${PUB}&home_domain=${HOME_DOMAIN}`)
  const tx = TransactionBuilder.fromXDR(challenge.transaction, challenge.network_passphrase)
  tx.sign(distributor)
  const { token } = await json(auth, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transaction: tx.toXDR() }),
  })
  return token
}

async function submit(tx) {
  try {
    return (await server.submitTransaction(tx)).hash
  } catch (e) {
    console.error('submit failed:', e?.response?.data?.extras ?? e)
    throw e
  }
}

async function balances() {
  const account = await server.loadAccount(PUB)
  return Object.fromEntries(
    account.balances.map(b => [b.asset_code ?? 'XLM', b.balance])
  )
}

async function main() {
  const { issuer, auth, transfer } = await discover()
  console.log(`anchor ${HOME_DOMAIN} issues ${ASSET_CODE} as ${issuer}`)
  console.log(`distributor ${PUB}`)

  const asset = new Asset(ASSET_CODE, issuer)
  let account = await server.loadAccount(PUB)
  const trusted = account.balances.some(
    b => b.asset_code === ASSET_CODE && b.asset_issuer === issuer
  )

  if (trusted) {
    console.log(`trustline: already open`)
  } else {
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.changeTrust({ asset }))
      .setTimeout(60)
      .build()
    tx.sign(distributor)
    console.log(`trustline: opened in ${await submit(tx)}`)
  }

  if (deposits > 0) {
    const token = await login(auth)
    const headers = { Authorization: `Bearer ${token}` }

    for (let i = 1; i <= deposits; i++) {
      // 3000 TRY is the anchor's per-deposit ceiling, so the float is built in
      // ceiling-sized bites rather than one impossible order.
      const order = await json(
        `${transfer}/deposit?asset_code=${ASSET_CODE}&account=${PUB}&amount=3000&funding_method=bank_account`,
        { headers }
      )
      await json(`${transfer}/tx/${order.id}/simulate-bank-transfer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: '3000.00' }),
      })

      let status = 'pending_anchor'
      for (let tries = 0; tries < 15 && status !== 'completed'; tries++) {
        await sleep(2000)
        const { transaction } = await json(`${transfer}/transaction?id=${order.id}`, { headers })
        status = transaction.status
        if (status === 'error') throw new Error(`deposit ${order.id} failed`)
      }
      console.log(`deposit ${i}/${deposits}: ${status}`)
    }
  }

  console.log('distributor now holds:', await balances())
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
