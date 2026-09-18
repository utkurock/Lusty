import { describe, it, expect } from 'vitest'
import { StrKey } from '@stellar/stellar-sdk'
import { verifyFunding, type ProofOperation, type ProofTransaction } from '../swap-proof'
import { LUSD_CODE, LUSD_ISSUER, LUSD_DISTRIBUTOR } from '../lusd'

// The swap route pays real balances out of the distributor against a payment
// the caller only claims to have made. These are the claims it must refuse.

const PAYER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x51))
const OTHER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x52))
const OTHER_ISSUER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x53))

const okTx = (over: Partial<ProofTransaction> = {}): ProofTransaction => ({
  successful: true,
  source_account: PAYER,
  ...over,
})

const lusdPayment = (over: Partial<ProofOperation> = {}): ProofOperation => ({
  type: 'payment',
  to: LUSD_DISTRIBUTOR,
  amount: '100.0000000',
  asset_type: 'credit_alphanum4',
  asset_code: LUSD_CODE,
  asset_issuer: LUSD_ISSUER,
  transaction_successful: true,
  ...over,
})

const xlmPayment = (over: Partial<ProofOperation> = {}): ProofOperation => ({
  type: 'payment',
  to: LUSD_DISTRIBUTOR,
  amount: '100.0000000',
  asset_type: 'native',
  transaction_successful: true,
  ...over,
})

const verify = (
  tx: ProofTransaction | null,
  operations: ProofOperation[],
  over: Partial<Parameters<typeof verifyFunding>[0]> = {},
) =>
  verifyFunding({
    tx,
    operations,
    direction: 'lusd_to_xlm',
    address: PAYER,
    sourceAmount: 100,
    ...over,
  })

describe('a failed transaction is not a payment', () => {
  // The finding this file exists for. A failed transaction keeps its hash, is
  // ingested, and Horizon returns its operations from
  // /transactions/{hash}/operations without include_failed — verified against
  // testnet, one payment record on a transaction with successful=false. Every
  // other field reads exactly as it would on a payment that moved money,
  // because they are fields of an operation that was submitted and rejected.
  it('refuses a transaction Horizon reports as unsuccessful', () => {
    const out = verify(okTx({ successful: false }), [lusdPayment()])
    expect('ok' in out).toBe(false)
    expect((out as any).code).toBe('tx_failed')
    expect((out as any).status).toBe(400)
  })

  it('refuses one whose success Horizon does not state', () => {
    for (const successful of [undefined, null as any, 'true' as any]) {
      const out = verify(okTx({ successful }), [lusdPayment()])
      expect((out as any).code).toBe('tx_failed')
    }
  })

  it('refuses when the operation itself carries the failure', () => {
    const out = verify(okTx(), [lusdPayment({ transaction_successful: false })])
    expect((out as any).code).toBe('payment_failed')
  })

  it('accepts the same claim once the transaction succeeded', () => {
    const out = verify(okTx(), [lusdPayment()])
    expect(out).toEqual({ ok: true, paidAmount: 100 })
  })
})

describe('the asset is named, not merely non-native', () => {
  // "Not native" is satisfied by any issued asset the distributor can hold,
  // and it would be paid out in XLM at the LUSD rate. The distributor holds
  // one trustline today; the check must not depend on that staying true.
  it('refuses another issuer s token spelled LUSD', () => {
    const out = verify(okTx(), [lusdPayment({ asset_issuer: OTHER_ISSUER })])
    expect((out as any).code).toBe('wrong_asset')
  })

  it('refuses another code from the real issuer', () => {
    const out = verify(okTx(), [lusdPayment({ asset_code: 'LBTC' })])
    expect((out as any).code).toBe('wrong_asset')
  })

  it('refuses XLM claimed as a LUSD payment, and the reverse', () => {
    expect((verify(okTx(), [xlmPayment()]) as any).code).toBe('wrong_asset')
    expect(
      (verify(okTx(), [lusdPayment()], { direction: 'xlm_to_lusd' }) as any).code,
    ).toBe('wrong_asset')
  })

  it('accepts native for the direction that names it', () => {
    const out = verify(okTx(), [xlmPayment()], { direction: 'xlm_to_lusd' })
    expect(out).toEqual({ ok: true, paidAmount: 100 })
  })
})

describe('the payment has to be this payer s, to this account', () => {
  it('refuses a transaction sent by somebody else', () => {
    const out = verify(okTx({ source_account: OTHER }), [lusdPayment()])
    expect((out as any).code).toBe('source_mismatch')
    expect((out as any).status).toBe(403)
  })

  it('refuses a payment to any other destination', () => {
    const out = verify(okTx(), [lusdPayment({ to: OTHER })])
    expect((out as any).code).toBe('not_to_distributor')
  })

  it('refuses a transaction carrying no payment at all', () => {
    const out = verify(okTx(), [{ type: 'create_account', to: LUSD_DISTRIBUTOR }])
    expect((out as any).code).toBe('not_to_distributor')
  })

  it('refuses a hash Horizon has never seen', () => {
    const out = verify(null, [])
    expect((out as any).code).toBe('tx_not_found')
    expect((out as any).status).toBe(404)
  })
})

describe('the payout is sized from the ledger', () => {
  it('returns what was paid, not what was claimed', () => {
    const out = verify(okTx(), [lusdPayment({ amount: '100.0050000' })])
    expect(out).toEqual({ ok: true, paidAmount: 100.005 })
  })

  it('refuses a claim the payment does not cover', () => {
    const out = verify(okTx(), [lusdPayment({ amount: '1.0000000' })])
    expect((out as any).code).toBe('amount_mismatch')
  })

  it('refuses an amount that is not a number', () => {
    for (const amount of ['', 'NaN', undefined]) {
      const out = verify(okTx(), [lusdPayment({ amount })], { sourceAmount: 0.0001 })
      expect((out as any).code).toBe('amount_unreadable')
    }
  })
})
