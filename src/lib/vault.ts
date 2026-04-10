// Classic-TX vault helpers.
//
// With no Soroban contract deployed, "deposits" are executed as a plain
// Stellar classic payment to the distributor account, followed by a
// server-side premium drip. The distributor acts as the vault escrow
// and counterparty.

import {
  Asset,
  Operation,
  TransactionBuilder,
  BASE_FEE,
  Networks,
} from '@stellar/stellar-sdk'
import { Horizon } from '@stellar/stellar-sdk'
import { HORIZON_URL, NETWORK_PASSPHRASE } from './stellar'
import { LUSD_CODE, LUSD_ISSUER, LUSD_DISTRIBUTOR } from './swap'

const horizon = new Horizon.Server(HORIZON_URL)

export interface VaultDepositParams {
  user: string
  type: 'call' | 'put'
  amount: string          // XLM for call, LUSD for put
}

/**
 * Build a classic payment tx that sends the user's collateral to the
 * distributor (the vault escrow). Signed by the user's wallet.
 */
export async function buildVaultDepositTx(
  params: VaultDepositParams
): Promise<string> {
  const acc = await horizon.loadAccount(params.user)
  const asset =
    params.type === 'call' ? Asset.native() : new Asset(LUSD_CODE, LUSD_ISSUER)

  const tx = new TransactionBuilder(acc, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: LUSD_DISTRIBUTOR,
        asset,
        amount: params.amount,
      })
    )
    .setTimeout(60)
    .build()

  return tx.toXDR()
}

/**
 * Build a payment tx for swap: user sends XLM or LUSD to the distributor.
 * Reuses the same deposit tx structure.
 */
export const buildSwapPaymentTx = buildVaultDepositTx

export async function submitUserTx(signedXdr: string): Promise<string> {
  const tx = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET)
  const res = await horizon.submitTransaction(tx as any)
  return (res as any).hash
}
