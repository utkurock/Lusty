import {
  Asset,
  Operation,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  Horizon,
} from '@stellar/stellar-sdk'
import { HORIZON_URL, NETWORK_PASSPHRASE } from './stellar'

// Classic Stellar DEX swap via path payments.
//
// Uses Horizon's path-finding endpoints to get a live quote between two
// classic assets, then builds a pathPaymentStrictSend operation that the
// user signs with the Stellar Wallets Kit.

const horizon = new Horizon.Server(HORIZON_URL)

// Lusty's testnet USD (LUSD) — see scripts/mint-lusd.mjs.
export const LUSD_CODE = process.env.NEXT_PUBLIC_LUSD_CODE ?? 'LUSD'
export const LUSD_ISSUER =
  process.env.NEXT_PUBLIC_LUSD_ISSUER ??
  'GBCMRD6NDL2RAJUOFQ25EHZVO3IRIGNESWE4QDRFB4AVFIP7IT5BRCJ6'
export const LUSD_DISTRIBUTOR =
  process.env.NEXT_PUBLIC_LUSD_DISTRIBUTOR ??
  'GBAIN6CHZJGBL365JNXSRQEKALXYTWKXANQZ3RBM7AGUEYYKLJJ6SNR6'

export type AssetCode = 'XLM' | 'LUSD'

export function assetOf(code: AssetCode): Asset {
  if (code === 'XLM') return Asset.native()
  return new Asset(LUSD_CODE, LUSD_ISSUER)
}

/**
 * Build a changeTrust tx so the user can hold LUSD. Must be signed and
 * submitted by the user's own wallet.
 */
export async function buildTrustlineTx(userAddress: string): Promise<string> {
  const account = await horizon.loadAccount(userAddress)
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.changeTrust({ asset: new Asset(LUSD_CODE, LUSD_ISSUER) })
    )
    .setTimeout(60)
    .build()
  return tx.toXDR()
}

/** Check whether `userAddress` already has a LUSD trustline. */
export async function hasLusdTrustline(userAddress: string): Promise<boolean> {
  try {
    const acc = await horizon.loadAccount(userAddress)
    return acc.balances.some(
      (b: any) => b.asset_code === LUSD_CODE && b.asset_issuer === LUSD_ISSUER
    )
  } catch {
    return false
  }
}

export interface SwapQuote {
  source: AssetCode
  destination: AssetCode
  sourceAmount: string
  destAmount: string
  minDestAmount: string
  path: Asset[]
  priceImpactPct: number
}

export async function quoteStrictSend(
  source: AssetCode,
  destination: AssetCode,
  sourceAmount: string,
  slippageBps = 50 // 0.5%
): Promise<SwapQuote | null> {
  if (source === destination) return null
  const src = assetOf(source)
  const dst = assetOf(destination)

  const builder = horizon.strictSendPaths(src, sourceAmount, [dst])
  const { records } = await builder.call()
  if (!records.length) return null

  // Best record = highest destination_amount
  const best = records.reduce((a, b) =>
    parseFloat(b.destination_amount) > parseFloat(a.destination_amount) ? b : a
  )

  const destAmount = parseFloat(best.destination_amount)
  const minDestAmount = (destAmount * (1 - slippageBps / 10_000)).toFixed(7)

  const path: Asset[] = best.path.map((p: any) =>
    p.asset_type === 'native' ? Asset.native() : new Asset(p.asset_code, p.asset_issuer)
  )

  // Rough price-impact proxy: distance between best and median
  const amounts = records.map((r: any) => parseFloat(r.destination_amount)).sort()
  const median = amounts[Math.floor(amounts.length / 2)]
  const priceImpactPct = Math.abs(((destAmount - median) / destAmount) * 100)

  return {
    source,
    destination,
    sourceAmount,
    destAmount: destAmount.toFixed(7),
    minDestAmount,
    path,
    priceImpactPct,
  }
}

export async function buildSwapTx(
  senderAddress: string,
  quote: SwapQuote
): Promise<string> {
  const account = await horizon.loadAccount(senderAddress)

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: assetOf(quote.source),
        sendAmount: quote.sourceAmount,
        destination: senderAddress,
        destAsset: assetOf(quote.destination),
        destMin: quote.minDestAmount,
        path: quote.path,
      })
    )
    .setTimeout(60)
    .build()

  return tx.toXDR()
}

export async function submitSignedTx(signedXdr: string): Promise<string> {
  const tx = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET)
  const res = await horizon.submitTransaction(tx as any)
  return (res as any).hash
}
