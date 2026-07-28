// Classic-payment helpers for the swap desk.
//
// These used to build the vault's deposits too: with no Soroban contract in
// the loop, "depositing" meant paying collateral to a server-held distributor
// account that acted as escrow and counterparty. That rail is gone. Positions
// are opened directly on the vault contract now (lib/vault-contract), which
// escrows the collateral itself and pays the premium in the same transaction,
// so no server key is ever in a position to hold or redirect it.
//
// What remains here is the swap desk, which genuinely is a payment to the
// distributor: the user sends one asset and the desk sends back the other.

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

export interface SwapPaymentParams {
  user: string
  /** Which side the user is paying in: XLM for 'call', LUSD for 'put'. */
  type: 'call' | 'put'
  amount: string
}

/**
 * Build a classic payment from the user to the swap distributor, signed by
 * the user's wallet.
 */
export async function buildSwapPaymentTx(
  params: SwapPaymentParams
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

export async function submitUserTx(signedXdr: string): Promise<string> {
  const tx = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET)
  const res = await horizon.submitTransaction(tx as any)
  return (res as any).hash
}
