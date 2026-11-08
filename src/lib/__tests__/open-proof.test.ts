import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  Account,
  Address,
  Contract,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk'

// proveOpen past the RPC's retention (finding 58): Horizon's copy of the
// transaction stands in for the `deposit` event, but only when its envelope is
// one successful open of exactly this position, and only when no other
// position of the owner's could have come from the same call.

const VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x11))
const OTHER_VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x22))
const OWNER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x66))
const QUOTER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x77))
const HASH = 'cd'.repeat(32)
const CREATED_AT = '2026-08-01T10:00:00Z'

const findOpenEvent = vi.fn()
const getPosition = vi.fn()
const getPositionIdsOf = vi.fn()

vi.mock('../contract-events', () => ({
  findOpenEvent: (...a: any[]) => findOpenEvent(...a),
}))
vi.mock('../vault-contract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../vault-contract')>()),
  getPosition: (...a: any[]) => getPosition(...a),
  getPositionIdsOf: (...a: any[]) => getPositionIdsOf(...a),
}))

const { proveOpen } = await import('../open-proof')
const { decodePosition } = await import('../vault-contract')
const { XLM } = await import('../assets')

const asset = { ...XLM, contracts: { ...XLM.contracts, vault: VAULT } }

const TERMS = {
  owner: OWNER,
  kind: 0,
  amount: 400_0000000n,
  strike: 15_400_000_000_000n,
  expiry: 1_794_556_800n,
  premium: 3_197_148n,
}
const position = decodePosition(7, { ...TERMS, settled: false, outcome: 'open' })

function openEnvelope(over: Partial<typeof TERMS> & { vault?: string; fn?: string } = {}) {
  const t = { ...TERMS, ...over }
  const args =
    over.fn === 'deposit'
      ? [
          new Address(t.owner).toScVal(),
          nativeToScVal(t.amount, { type: 'i128' }),
          nativeToScVal(t.strike, { type: 'i128' }),
          nativeToScVal(t.expiry, { type: 'u64' }),
          nativeToScVal(t.premium, { type: 'i128' }),
          new Address(QUOTER).toScVal(),
        ]
      : [
          new Address(t.owner).toScVal(),
          nativeToScVal(t.kind, { type: 'u32' }),
          nativeToScVal(t.amount, { type: 'i128' }),
          nativeToScVal(t.strike, { type: 'i128' }),
          nativeToScVal(t.expiry, { type: 'u64' }),
          nativeToScVal(t.premium, { type: 'i128' }),
          new Address(QUOTER).toScVal(),
        ]
  return new TransactionBuilder(new Account(OWNER, '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(over.vault ?? VAULT).call(over.fn ?? 'open', ...args))
    .setTimeout(0)
    .build()
    .toEnvelope()
    .toXDR('base64')
}

function horizon(tx: Record<string, unknown> | null, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(tx ? JSON.stringify(tx) : '{}', { status: tx ? status : 404 }),
    ),
  )
}

const historyTx = (over: Record<string, unknown> = {}) => ({
  hash: HASH,
  successful: true,
  created_at: CREATED_AT,
  envelope_xdr: openEnvelope(),
  ...over,
})

beforeEach(() => {
  findOpenEvent.mockReset().mockResolvedValue(null)
  getPosition.mockReset()
  getPositionIdsOf.mockReset().mockResolvedValue([7])
  horizon(historyTx())
})

describe('proveOpen', () => {
  it('takes the deposit event when the RPC still has it, without asking Horizon', async () => {
    findOpenEvent.mockResolvedValue({ at: 123 })
    expect(await proveOpen(asset, position, HASH)).toEqual({ at: 123 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('proves an open past the RPC retention from Horizon, at its close time', async () => {
    expect(await proveOpen(asset, position, HASH)).toEqual({ at: Date.parse(CREATED_AT) })
  })

  it('accepts the covered-call alias', async () => {
    horizon(historyTx({ envelope_xdr: openEnvelope({ fn: 'deposit' }) }))
    expect(await proveOpen(asset, position, HASH)).toEqual({ at: Date.parse(CREATED_AT) })
  })

  it('refuses a transaction whose terms are not this position', async () => {
    horizon(historyTx({ envelope_xdr: openEnvelope({ amount: 401_0000000n }) }))
    expect(await proveOpen(asset, position, HASH)).toBeNull()
  })

  it('refuses an open on another instance', async () => {
    horizon(historyTx({ envelope_xdr: openEnvelope({ vault: OTHER_VAULT }) }))
    expect(await proveOpen(asset, position, HASH)).toBeNull()
  })

  it('refuses a failed transaction and a fee bump', async () => {
    horizon(historyTx({ successful: false }))
    expect(await proveOpen(asset, position, HASH)).toBeNull()
    horizon(historyTx({ fee_bump_transaction: { hash: 'ef'.repeat(32) } }))
    expect(await proveOpen(asset, position, HASH)).toBeNull()
  })

  it('refuses a hash Horizon does not know', async () => {
    horizon(null)
    expect(await proveOpen(asset, position, HASH)).toBeNull()
  })

  it('refuses when the owner holds a twin the same call could have opened', async () => {
    // Horizon cannot say which id an open returned, so two positions with
    // identical terms are indistinguishable and neither is proven this way.
    getPositionIdsOf.mockResolvedValue([3, 7])
    getPosition.mockResolvedValue({ ...position, id: 3 })
    expect(await proveOpen(asset, position, HASH)).toBeNull()
  })

  it('accepts when the owner holds other positions with different terms', async () => {
    getPositionIdsOf.mockResolvedValue([3, 7])
    getPosition.mockResolvedValue({ ...position, id: 3, collateral: 1 })
    expect(await proveOpen(asset, position, HASH)).toEqual({ at: Date.parse(CREATED_AT) })
  })

  it('throws when Horizon cannot be read, so the caller retries rather than refuses', async () => {
    horizon(historyTx(), 503)
    await expect(proveOpen(asset, position, HASH)).rejects.toThrow(/horizon: 503/)
  })
})
