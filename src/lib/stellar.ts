import {
  Contract,
  Networks,
  rpc,
  TransactionBuilder,
  BASE_FEE,
  Transaction,
  nativeToScVal,
  scValToNative,
  Address,
  xdr,
} from '@stellar/stellar-sdk'

export const NETWORK_PASSPHRASE = Networks.TESTNET
export const RPC_URL = 'https://soroban-testnet.stellar.org'
export const HORIZON_URL = 'https://horizon-testnet.stellar.org'

export const server = new rpc.Server(RPC_URL, { allowHttp: false })

export const CONTRACTS = {
  COVERED_CALL_VAULT: process.env.NEXT_PUBLIC_COVERED_CALL_CONTRACT ?? '',
  PUT_VAULT: process.env.NEXT_PUBLIC_PUT_VAULT_CONTRACT ?? '',
  USDC: process.env.NEXT_PUBLIC_USDC_CONTRACT ?? 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  XLM: 'native',
}

export interface InvokeParams {
  contractId: string
  method: string
  args: xdr.ScVal[]
  signerAddress: string
  signTransaction: (xdr: string) => Promise<string>
}

export async function invokeContract({
  contractId,
  method,
  args,
  signerAddress,
  signTransaction,
}: InvokeParams): Promise<any> {
  const account = await server.getAccount(signerAddress)
  const contract = new Contract(contractId)

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build()

  const simResult = await server.simulateTransaction(tx)

  if (rpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation error: ${simResult.error}`)
  }

  const preparedTx = rpc.assembleTransaction(tx, simResult).build()
  const signedXdr = await signTransaction(preparedTx.toXDR())
  const signedTx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE)

  const sendResult = await server.sendTransaction(signedTx)
  if (sendResult.status === 'ERROR') {
    throw new Error(`Send failed: ${sendResult.errorResult}`)
  }

  let getResult = await server.getTransaction(sendResult.hash)
  let attempts = 0
  while (getResult.status === 'NOT_FOUND' && attempts < 20) {
    await new Promise(r => setTimeout(r, 1500))
    getResult = await server.getTransaction(sendResult.hash)
    attempts++
  }

  if (getResult.status === 'FAILED') {
    throw new Error('Transaction failed on chain')
  }

  if (getResult.status === 'SUCCESS' && getResult.returnValue) {
    return scValToNative(getResult.returnValue)
  }

  return null
}

export async function readContract({
  contractId,
  method,
  args,
  signerAddress,
}: Omit<InvokeParams, 'signTransaction'>): Promise<any> {
  const account = await server.getAccount(signerAddress)
  const contract = new Contract(contractId)

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build()

  const simResult = await server.simulateTransaction(tx)

  if (rpc.Api.isSimulationError(simResult)) {
    throw new Error(`Read error: ${simResult.error}`)
  }

  if (rpc.Api.isSimulationSuccess(simResult) && simResult.result?.retval) {
    return scValToNative(simResult.result.retval)
  }

  return null
}
