// One-shot: mint Lusty's test BTC (LBTC) on Stellar testnet.
//
//   node scripts/mint-lbtc.mjs
//
// Same shape as mint-lusd.mjs, for the other side of the book: a covered call
// escrows the underlying, so BTC needs an issued asset to escrow before the
// vault can write one. Stellar testnet has no wrapped-BTC anchor — the asset
// code is unreserved there and the issuers holding it are anonymous test
// accounts — so the underlying is issued here, by a key this repo controls,
// exactly as LUSD is. It is a TEST ASSET: no reserve, no redemption, no
// custody claim. Mainnet needs a real anchor; that is a separate decision and
// does not block a testnet lifecycle, because settlement prices off the
// Reflector BTC/USD feed rather than off whoever issued the collateral.
//
// Produces an issuer keypair, a distributor keypair, funds both via Friendbot,
// opens a trustline from distributor → LBTC, mints the supply, and deploys the
// asset's SAC so the vault can hold it as a contract balance. Prints everything
// you need to paste into .env.local.

import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  Networks,
  BASE_FEE,
  rpc,
} from '@stellar/stellar-sdk'

const HORIZON = 'https://horizon-testnet.stellar.org'
const RPC_URL = 'https://soroban-testnet.stellar.org'
const FRIENDBOT = 'https://friendbot.stellar.org'
const server = new Horizon.Server(HORIZON)
const soroban = new rpc.Server(RPC_URL)

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

/** Submit a Soroban transaction and wait for it to leave PENDING. */
async function submitSoroban(tx, signer) {
  const prepared = await soroban.prepareTransaction(tx)
  prepared.sign(signer)
  const sent = await soroban.sendTransaction(prepared)
  if (sent.status === 'ERROR') {
    console.error('send failed:', sent.errorResult ?? sent)
    throw new Error('soroban send failed')
  }
  for (let i = 0; i < 30; i++) {
    const got = await soroban.getTransaction(sent.hash)
    if (got.status === 'SUCCESS') return sent.hash
    if (got.status === 'FAILED') {
      console.error('tx failed:', got.resultXdr?.toXDR?.('base64') ?? got)
      throw new Error('soroban tx failed')
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`timed out waiting for ${sent.hash}`)
}

async function main() {
  const issuer = Keypair.random()
  const distributor = Keypair.random()
  const ASSET_CODE = 'LBTC'
  // Sized against the book, not against Bitcoin's supply: the covered-call cap
  // is 5 BTC a month, so 1,000 is years of testnet capacity and still small
  // enough that no figure on screen reads like a real reserve.
  const MINT_AMOUNT = '1000'

  console.log('→ generated keys')
  console.log('  issuer     :', issuer.publicKey())
  console.log('  distributor:', distributor.publicKey())

  console.log('→ funding via friendbot')
  await Promise.all([friendbot(issuer.publicKey()), friendbot(distributor.publicKey())])

  const asset = new Asset(ASSET_CODE, issuer.publicKey())

  // 1) distributor opens a trustline to LBTC
  console.log('→ opening trustline (distributor → LBTC)')
  const distAccount = await server.loadAccount(distributor.publicKey())
  const trustTx = new TransactionBuilder(distAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset, limit: '1000000' }))
    .setTimeout(60)
    .build()
  trustTx.sign(distributor)
  console.log('   tx:', await submit(trustTx))

  // 2) issuer home_domain, so the asset carries a label rather than a bare key
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
  console.log('   tx:', await submit(homeTx))

  // 3) issuer mints LBTC to distributor
  console.log(`→ minting ${MINT_AMOUNT} LBTC → distributor`)
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
  console.log('   tx:', await submit(mintTx))

  // 4) deploy the asset's SAC. The vault escrows through a contract balance,
  //    so the classic asset alone is not enough: the registry's `token` is this
  //    address. The id is derived from asset + network, so it is the same
  //    address whoever deploys it — deploying only makes it exist.
  const sacId = asset.contractId(Networks.TESTNET)
  console.log('→ deploying SAC', sacId)
  const sacAccount = await soroban.getAccount(issuer.publicKey())
  const sacTx = new TransactionBuilder(sacAccount, {
    fee: '1000000',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.createStellarAssetContract({ asset: asset.toString() }))
    .setTimeout(60)
    .build()
  console.log('   tx:', await submitSoroban(sacTx, issuer))

  console.log('\n✓ done. paste into .env.local:\n')
  console.log(`NEXT_PUBLIC_BTC_ANCHOR_CODE=${ASSET_CODE}`)
  console.log(`NEXT_PUBLIC_BTC_ANCHOR_ISSUER=${issuer.publicKey()}`)
  console.log(`NEXT_PUBLIC_BTC_CONTRACT=${sacId}`)
  console.log(`LBTC_DISTRIBUTOR=${distributor.publicKey()}`)
  console.log(`LBTC_DISTRIBUTOR_SECRET=${distributor.secret()}`)
  console.log(`LBTC_ISSUER_SECRET=${issuer.secret()}  # keep private, only needed to mint more`)
  console.log(
    '\nBTC stays gated until NEXT_PUBLIC_VAULT_CONTRACT_BTC names its own vault instance.'
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
