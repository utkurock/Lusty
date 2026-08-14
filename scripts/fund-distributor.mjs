// Top up the distributor on testnet.
//
// Friendbot funds new accounts only (it refuses one that already exists), so
// the way to add testnet XLM to a live account is to create throwaway accounts
// and merge them in. Each merge moves the whole balance and closes the account,
// leaving nothing behind to clean up.
//
// Usage: node scripts/fund-distributor.mjs <count>

import { readFileSync } from 'node:fs'
import { Horizon, Keypair, Networks, Operation, TransactionBuilder, BASE_FEE } from '@stellar/stellar-sdk'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
)

const horizon = new Horizon.Server(env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org')
const DEST = env.NEXT_PUBLIC_LUSD_DISTRIBUTOR
const count = Number(process.argv[2] ?? 1)

const before = parseFloat(
  (await horizon.loadAccount(DEST)).balances.find((b) => b.asset_type === 'native').balance
)
console.log(`distributor before: ${before.toLocaleString('en-US')} XLM`)

for (let i = 0; i < count; i++) {
  const kp = Keypair.random()
  const res = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`)
  if (!res.ok) { console.error(`  ${i + 1}: friendbot refused`); continue }
  const acc = await horizon.loadAccount(kp.publicKey())
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.accountMerge({ destination: DEST }))
    .setTimeout(60)
    .build()
  tx.sign(kp)
  const sent = await horizon.submitTransaction(tx)
  console.log(`  ${i + 1}: merged ${kp.publicKey().slice(0, 8)}… → ${sent.hash.slice(0, 10)}`)
}

const after = parseFloat(
  (await horizon.loadAccount(DEST)).balances.find((b) => b.asset_type === 'native').balance
)
console.log(`distributor after:  ${after.toLocaleString('en-US')} XLM  (+${(after - before).toLocaleString('en-US')})`)
