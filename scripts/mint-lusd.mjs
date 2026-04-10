// One-shot: mint Lusty's test USD (LUSD) on Stellar testnet.
//
//   node scripts/mint-lusd.mjs
//
// Produces an issuer keypair, a distributor keypair, funds both via
// Friendbot, opens a trustline from distributor → LUSD, and mints
// 1,000,000 LUSD to the distributor. Prints everything you need to
// paste into .env.local.

import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  Networks,
  BASE_FEE,
} from '@stellar/stellar-sdk'

const HORIZON = 'https://horizon-testnet.stellar.org'
const FRIENDBOT = 'https://friendbot.stellar.org'
const server = new Horizon.Server(HORIZON)

async function friendbot(pub) {
  const r = await fetch(`${FRIENDBOT}/?addr=${pub}`)
  if (!r.ok) throw new Error(`friendbot ${r.status}: ${await r.text()}`)
}

async function submit(tx) {
  try {
    const res = await server.submitTransaction(tx)
    return res.hash
  } catch (e) {
    const extras = e?.response?.data?.extras
    console.error('submit failed:', extras ?? e)
    throw e
  }
}

async function main() {
  const issuer = Keypair.random()
  const distributor = Keypair.random()
  const ASSET_CODE = 'LUSD'
  const MINT_AMOUNT = '1000000' // 1M LUSD

  console.log('→ generated keys')
  console.log('  issuer     :', issuer.publicKey())
  console.log('  distributor:', distributor.publicKey())

  console.log('→ funding via friendbot')
  await Promise.all([friendbot(issuer.publicKey()), friendbot(distributor.publicKey())])

  const asset = new Asset(ASSET_CODE, issuer.publicKey())

  // 1) distributor opens a trustline to LUSD
  console.log('→ opening trustline (distributor → LUSD)')
  const distAccount = await server.loadAccount(distributor.publicKey())
  const trustTx = new TransactionBuilder(distAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset, limit: '10000000' }))
    .setTimeout(60)
    .build()
  trustTx.sign(distributor)
  const trustHash = await submit(trustTx)
  console.log('   tx:', trustHash)

  // 2) issuer home_domain + set flags (optional polish so it shows a label)
  console.log('→ issuer: set home_domain')
  const issuerAccount = await server.loadAccount(issuer.publicKey())
  const homeTx = new TransactionBuilder(issuerAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.setOptions({ homeDomain: 'lusty.finance' }))
    .setTimeout(60)
    .build()
  homeTx.sign(issuer)
  const homeHash = await submit(homeTx)
  console.log('   tx:', homeHash)

  // 3) issuer mints LUSD to distributor
  console.log(`→ minting ${MINT_AMOUNT} LUSD → distributor`)
  const issuerAccount2 = await server.loadAccount(issuer.publicKey())
  const mintTx = new TransactionBuilder(issuerAccount2, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: distributor.publicKey(),
        asset,
        amount: MINT_AMOUNT,
      })
    )
    .setTimeout(60)
    .build()
  mintTx.sign(issuer)
  const mintHash = await submit(mintTx)
  console.log('   tx:', mintHash)

  console.log('\n✓ done. paste into .env.local:\n')
  console.log(`NEXT_PUBLIC_LUSD_CODE=${ASSET_CODE}`)
  console.log(`NEXT_PUBLIC_LUSD_ISSUER=${issuer.publicKey()}`)
  console.log(`NEXT_PUBLIC_LUSD_DISTRIBUTOR=${distributor.publicKey()}`)
  console.log(`LUSD_DISTRIBUTOR_SECRET=${distributor.secret()}`)
  console.log(`LUSD_ISSUER_SECRET=${issuer.secret()}  # keep private, only needed to mint more`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
