import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import { fakeDb, fakeHorizon } from './payout-fakes'

// One funding payment, one payout, however its hash is spelled.
// =============================================================
// The swap and the bridge used to key the replay guard on the caller's raw
// txHash and fetch the funding record with that same raw string. The SDK puts
// it into a URL path, where 'x/../H', './H' and '%2e/H' all resolve to
// /transactions/H — so each spelling fetched the same payment, passed the same
// proof, and reserved a new key. Five spellings, five payouts. These drive the
// real routes, proofs, guard and SDK call builders against a Horizon that
// answers exact paths only, and count what the distributor sent.

const DISTRIBUTOR = Keypair.random()
const ISSUER = Keypair.random().publicKey()
const USDC_ISSUER = Keypair.random().publicKey()
const PAYER = Keypair.random().publicKey()

process.env.LUSD_DISTRIBUTOR_SECRET = DISTRIBUTOR.secret()
process.env.NEXT_PUBLIC_LUSD_DISTRIBUTOR = DISTRIBUTOR.publicKey()
process.env.NEXT_PUBLIC_LUSD_ISSUER = ISSUER
process.env.NEXT_PUBLIC_ANCHOR_ASSET_ISSUER = USDC_ISSUER
delete process.env.FEE_WALLET

const db = fakeDb()
const horizon = fakeHorizon()
vi.stubGlobal('fetch', horizon.fetch)

vi.mock('@/lib/db', () => ({ ensureSchema: async () => {}, getPool: () => db.pool }))
vi.mock('@/lib/db-queries', () => ({ logTransaction: vi.fn(async () => {}) }))
vi.mock('@/lib/rate-limit', () => ({ durableRateLimit: async () => ({ ok: true }) }))
vi.mock('@/lib/spot', () => ({ fetchXlmUsd: async () => 0.1 }))
vi.mock('@/lib/reflector', () => ({ reflectorPriceAt: async () => null }))

const swap = await import('@/app/api/swap/route')
const bridge = await import('@/app/api/anchor/bridge/route')
const { reserveAction } = await import('@/lib/idempotency')
const { verifyBridgeFunding } = await import('@/lib/anchor/bridge-proof')
const { FUNDING_MAX_AGE_MS } = await import('@/lib/swap-proof')

const SWAP_H = 'ef'.repeat(32)
const BRIDGE_H = 'cd'.repeat(32)

const spellings = (h: string) => [h, `x/../${h}`, `./${h}`, `%2e/${h}`, `a/b/../../${h}`, h.toUpperCase()]

function stockHorizon() {
  const createdAt = new Date(Date.now() - 30_000).toISOString()
  horizon.txs.set(SWAP_H, {
    tx: { hash: SWAP_H, successful: true, source_account: PAYER, created_at: createdAt },
    operations: [
      {
        type: 'payment',
        to: DISTRIBUTOR.publicKey(),
        amount: '100.0000000',
        asset_type: 'native',
        transaction_successful: true,
      },
    ],
  })
  horizon.txs.set(BRIDGE_H, {
    tx: { hash: BRIDGE_H, successful: true, source_account: PAYER, created_at: createdAt },
    operations: [
      {
        type: 'payment',
        to: DISTRIBUTOR.publicKey(),
        amount: '10.0000000',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: USDC_ISSUER,
        transaction_successful: true,
      },
    ],
  })
  const lusd = { asset_type: 'credit_alphanum4', asset_code: 'LUSD', asset_issuer: ISSUER, balance: '100000' }
  horizon.accounts.set(PAYER, { id: PAYER, balances: [lusd, { asset_type: 'native', balance: '1000' }] })
  horizon.accounts.set(DISTRIBUTOR.publicKey(), {
    id: DISTRIBUTOR.publicKey(),
    balances: [lusd, { asset_type: 'native', balance: '100000' }],
  })
}

beforeEach(() => {
  db.reset()
  horizon.reset()
  stockHorizon()
})

const post = (handler: (r: Request) => Promise<Response>, url: string, body: unknown) =>
  handler(
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const claimSwap = (txHash: string) =>
  post(swap.POST, 'http://t/api/swap', {
    address: PAYER,
    txHash,
    direction: 'xlm_to_lusd',
    sourceAmount: 100,
    expectedDestAmount: 9.99,
  })

const claimBridge = (txHash: string) =>
  post(bridge.POST, 'http://t/api/anchor/bridge', {
    address: PAYER,
    txHash,
    direction: 'anchor_to_cash',
    sourceAmount: 10,
  })

describe('the swap pays one funding hash once', () => {
  it('refuses every other spelling of a hash it has paid', async () => {
    const statuses: number[] = []
    for (const h of spellings(SWAP_H)) statuses.push((await claimSwap(h)).status)

    expect(statuses[0]).toBe(200)
    for (const s of statuses.slice(1)) expect([400, 409]).toContain(s)
    expect(horizon.payouts()).toBe(1)
    expect(db.actions.map((r) => r.hash)).toEqual([SWAP_H])
  })

  it('never asks Horizon for anything but the canonical path', async () => {
    for (const h of spellings(SWAP_H).slice(1, 5)) {
      const res = await claimSwap(h)
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('invalid_tx_hash')
    }
    expect(horizon.paths).toEqual([])
  })

  it('folds case, so the uppercase hash is the same key', async () => {
    expect((await claimSwap(SWAP_H.toUpperCase())).status).toBe(200)
    expect((await claimSwap(SWAP_H)).status).toBe(409)
    expect(horizon.payouts()).toBe(1)
    expect(db.actions[0].hash).toBe(SWAP_H)
  })

  it('refuses a record that is not the transaction asked for', async () => {
    // Whatever Horizon answered with, it has to name the hash requested.
    horizon.txs.get(SWAP_H)!.tx.hash = 'ab'.repeat(32)
    const res = await claimSwap(SWAP_H)
    expect(res.status).toBe(404)
    expect(horizon.payouts()).toBe(0)
  })
})

describe('the bridge pays one funding hash once', () => {
  it('refuses every other spelling of a hash it has paid', async () => {
    const statuses: number[] = []
    for (const h of spellings(BRIDGE_H)) statuses.push((await claimBridge(h)).status)

    expect(statuses[0]).toBe(200)
    for (const s of statuses.slice(1)) expect([400, 409]).toContain(s)
    expect(horizon.payouts()).toBe(1)
    expect(db.actions.map((r) => r.hash)).toEqual([BRIDGE_H])
  })

  it('refuses a funding payment older than the swap allows', async () => {
    horizon.txs.get(BRIDGE_H)!.tx.created_at = new Date(Date.now() - FUNDING_MAX_AGE_MS - 60_000).toISOString()
    const res = await claimBridge(BRIDGE_H)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('funding_stale')
    expect(horizon.payouts()).toBe(0)
  })

  it('applies the age bound in the proof itself', () => {
    const now = Date.now()
    const stale = verifyBridgeFunding({
      tx: {
        hash: BRIDGE_H,
        successful: true,
        source_account: PAYER,
        created_at: new Date(now - FUNDING_MAX_AGE_MS - 1).toISOString(),
      },
      operations: horizon.txs.get(BRIDGE_H)!.operations,
      direction: 'anchor_to_cash',
      address: PAYER,
      sourceAmount: 10,
      maxAgeMs: FUNDING_MAX_AGE_MS,
      now,
    })
    expect(stale).toMatchObject({ code: 'funding_stale' })
  })
})

describe('the guard itself', () => {
  it('refuses a swap key that is not 64 lowercase hex, whoever calls it', async () => {
    for (const h of [`x/../${SWAP_H}`, SWAP_H.toUpperCase(), SWAP_H.slice(1), '']) {
      await expect(reserveAction('swap', h)).rejects.toThrow()
    }
    expect(db.actions).toEqual([])
  })

  it('still takes the deposit route s position keys', async () => {
    await expect(reserveAction('deposit', 'XLM:3')).resolves.toEqual({ reserved: true, alreadyProcessed: false })
  })
})
