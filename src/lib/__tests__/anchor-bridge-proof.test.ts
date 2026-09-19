import { describe, it, expect } from 'vitest'
import { StrKey } from '@stellar/stellar-sdk'
import { verifyBridgeFunding, legsOf, isBridgeDirection } from '@/lib/anchor/bridge-proof'
import type { ProofOperation, ProofTransaction } from '@/lib/swap-proof'
import { LUSD_CODE, LUSD_ISSUER, LUSD_DISTRIBUTOR } from '@/lib/lusd'
import { ANCHOR_ASSET_CODE, ANCHOR_ASSET_ISSUER } from '@/lib/anchor/config'

// The bridge pays real balances out of the distributor against a payment the
// caller only claims to have made. These are the claims it must refuse.
//
// One of them is new to this route and is the reason it does not share the
// swap's verifier: the distributor holds two issued assets now, so a payment
// arriving in the wrong dollar has to be refused by name.

const PAYER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x61))
const OTHER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x62))
const IMPOSTOR = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x63))

const okTx = (over: Partial<ProofTransaction> = {}): ProofTransaction => ({
  successful: true,
  source_account: PAYER,
  ...over,
})

const anchorPayment = (over: Partial<ProofOperation> = {}): ProofOperation => ({
  type: 'payment',
  to: LUSD_DISTRIBUTOR,
  amount: '100.0000000',
  asset_type: 'credit_alphanum4',
  asset_code: ANCHOR_ASSET_CODE,
  asset_issuer: ANCHOR_ASSET_ISSUER,
  transaction_successful: true,
  ...over,
})

const cashPayment = (over: Partial<ProofOperation> = {}): ProofOperation => ({
  ...anchorPayment(),
  asset_code: LUSD_CODE,
  asset_issuer: LUSD_ISSUER,
  ...over,
})

const verify = (
  tx: ProofTransaction | null,
  operations: ProofOperation[],
  over: { direction?: 'anchor_to_cash' | 'cash_to_anchor'; sourceAmount?: number } = {}
) =>
  verifyBridgeFunding({
    tx,
    operations,
    direction: over.direction ?? 'anchor_to_cash',
    address: PAYER,
    sourceAmount: over.sourceAmount ?? 100,
  })

describe('bridge legs', () => {
  it('pays what the other direction receives', () => {
    expect(legsOf('anchor_to_cash').pays).toEqual(legsOf('cash_to_anchor').receives)
    expect(legsOf('anchor_to_cash').receives).toEqual(legsOf('cash_to_anchor').pays)
  })

  it('only admits the two directions it implements', () => {
    expect(isBridgeDirection('anchor_to_cash')).toBe(true)
    expect(isBridgeDirection('xlm_to_lusd')).toBe(false)
    expect(isBridgeDirection(undefined)).toBe(false)
  })
})

describe('bridge funding proof', () => {
  it('accepts a payment that is what it claims to be', () => {
    const proof = verify(okTx(), [anchorPayment()])
    expect(proof).toEqual({ ok: true, paidAmount: 100 })
  })

  it('sizes the payout from the ledger, not from the claim', () => {
    const proof = verify(okTx(), [anchorPayment({ amount: '100.0050000' })])
    expect(proof).toMatchObject({ ok: true, paidAmount: 100.005 })
  })

  /* The claim is what a crossing is denominated in; a payment for a different
     amount is a different crossing. */
  it('refuses an amount that does not match the claim', () => {
    expect(verify(okTx(), [anchorPayment({ amount: '500.0000000' })])).toMatchObject({
      code: 'amount_mismatch',
    })
  })

  it('refuses a transaction that did not succeed', () => {
    expect(verify(okTx({ successful: false }), [anchorPayment()])).toMatchObject({
      code: 'tx_failed',
    })
    expect(
      verify(okTx(), [anchorPayment({ transaction_successful: false })])
    ).toMatchObject({ code: 'payment_failed' })
  })

  it('refuses a hash somebody else paid', () => {
    expect(verify(okTx({ source_account: OTHER }), [anchorPayment()])).toMatchObject({
      code: 'source_mismatch',
    })
  })

  it('refuses a payment that went somewhere other than the distributor', () => {
    expect(verify(okTx(), [anchorPayment({ to: OTHER })])).toMatchObject({
      code: 'not_to_distributor',
    })
    expect(verify(okTx(), [])).toMatchObject({ code: 'not_to_distributor' })
  })

  it('has nothing to verify when the transaction is not on the ledger', () => {
    expect(verify(null, [])).toMatchObject({ code: 'tx_not_found' })
  })

  /* The distributor holds both dollars. Paying the cheap one and claiming the
     other is the whole attack this route adds, so it is named twice. */
  it('refuses the other dollar in either direction', () => {
    expect(verify(okTx(), [cashPayment()], { direction: 'anchor_to_cash' })).toMatchObject({
      code: 'wrong_asset',
    })
    expect(verify(okTx(), [anchorPayment()], { direction: 'cash_to_anchor' })).toMatchObject({
      code: 'wrong_asset',
    })
  })

  /* Same code, different issuer: anyone can issue an asset called USDC. */
  it('refuses an asset with the right code and the wrong issuer', () => {
    expect(verify(okTx(), [anchorPayment({ asset_issuer: IMPOSTOR })])).toMatchObject({
      code: 'wrong_asset',
    })
  })

  it('refuses native XLM, which neither direction names', () => {
    expect(
      verify(okTx(), [anchorPayment({ asset_type: 'native', asset_code: undefined, asset_issuer: undefined })])
    ).toMatchObject({ code: 'wrong_asset' })
  })

  it('refuses a payment with no readable amount', () => {
    expect(verify(okTx(), [anchorPayment({ amount: 'not-a-number' })])).toMatchObject({
      code: 'amount_unreadable',
    })
  })
})
