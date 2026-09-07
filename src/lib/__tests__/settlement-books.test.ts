import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { Keypair, StrKey } from '@stellar/stellar-sdk'
import type { VaultPosition } from '../vault-contract'

// Settlement across two books, with the chain mocked and everything else real.

const XLM_VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x11))
const BTC_VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x22))
const BTC_SAC = StrKey.encodeContract(Buffer.alloc(32, 0x33))
const BTC_ISSUER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x44))

const getVaultStats = vi.fn()
const getPosition = vi.fn()
const settlePosition = vi.fn()

vi.mock('../vault-contract', () => ({
  getVaultStats: (...a: any[]) => getVaultStats(...a),
  getPosition: (...a: any[]) => getPosition(...a),
  settlePosition: (...a: any[]) => settlePosition(...a),
}))

let settlement: typeof import('../settlement')
let sweep: typeof import('../settlement-sweep')

const NOW = new Date('2026-08-01T12:00:00Z')
const DAY = 86_400_000
const signer = Keypair.random()

beforeAll(async () => {
  process.env.NEXT_PUBLIC_VAULT_CONTRACT = XLM_VAULT
  process.env.NEXT_PUBLIC_VAULT_CONTRACT_BTC = BTC_VAULT
  process.env.NEXT_PUBLIC_BTC_ANCHOR_ISSUER = BTC_ISSUER
  process.env.NEXT_PUBLIC_BTC_CONTRACT = BTC_SAC
  vi.resetModules()
  settlement = await import('../settlement')
  sweep = await import('../settlement-sweep')
})

/** An expired, unsettled position. */
const expired = (id: number): VaultPosition => ({
  id,
  owner: 'GWRITER',
  side: 'call',
  collateral: 1000,
  strike: 0.25,
  expiry: new Date(NOW.getTime() - DAY),
  premium: 4,
  settled: false,
  outcome: 'open',
})

/** Each vault answers with a book of its own size. */
function chain(sizes: Record<string, number>) {
  getVaultStats.mockImplementation(async (asset: any) => ({
    escrowedCall: 0,
    escrowedPut: 0,
    owedCall: 0,
    owedPut: 0,
    cashBalance: 0,
    underlyingBalance: 0,
    nextId: sizes[asset?.symbol ?? 'XLM'] ?? 0,
  }))
  getPosition.mockImplementation(async (id: number) => expired(id))
  settlePosition.mockImplementation(async (id: number, _s: any, asset: any) => ({
    txHash: `${asset.symbol}-${id}`,
    outcome: 'kept',
  }))
}

beforeEach(() => {
  getVaultStats.mockReset()
  getPosition.mockReset()
  settlePosition.mockReset()
})

describe('the scan walks one book at a time', () => {
  it('reads ids out of the instance it was given', async () => {
    chain({ XLM: 2, BTC: 2 })
    const btc = await settlement.scanForSettlement({
      now: NOW,
      asset: (await import('../assets')).BTC,
    })

    expect(btc.underlying).toBe('BTC')
    expect(btc.candidates.every((c) => c.underlying === 'BTC')).toBe(true)
    for (const call of getPosition.mock.calls) {
      expect(call[1]).toMatchObject({ symbol: 'BTC' })
    }
  })
})

describe('a settlement goes to the book its candidate names', () => {
  it('never submits an id against the default instance', async () => {
    chain({ XLM: 0, BTC: 0 })
    const assets = await import('../assets')

    // Same id in both books. Settling them against one instance would close
    // whichever position happens to hold that id there.
    const candidates = [assets.XLM, assets.BTC].map((a) => ({
      id: 3,
      underlying: a.symbol,
      owner: 'GWRITER',
      side: 'call' as const,
      strike: 0.25,
      collateral: 1000,
      expiry: new Date(NOW.getTime() - DAY),
      settleBy: new Date(NOW.getTime()),
      pastDeadline: false,
    }))

    const run = await settlement.runSettlement(candidates, signer)

    expect(run.settled.map((s) => s.txHash)).toEqual(['XLM-3', 'BTC-3'])
    expect(settlePosition.mock.calls.map((c) => c[2].symbol)).toEqual(['XLM', 'BTC'])
  })

  it('refuses a candidate whose book has no vault, rather than settling elsewhere', async () => {
    chain({ XLM: 0 })
    const run = await settlement.runSettlement(
      [
        {
          id: 3,
          underlying: 'ETH' as any,
          owner: 'GWRITER',
          side: 'call',
          strike: 1,
          collateral: 1,
          expiry: new Date(NOW.getTime() - DAY),
          settleBy: new Date(NOW.getTime()),
          pastDeadline: false,
        },
      ],
      signer,
    )

    // The failure that matters: nothing was submitted. A BTC position must not
    // settle off XLM's price because BTC's own vault could not be found.
    expect(settlePosition).not.toHaveBeenCalled()
    expect(run.settled).toEqual([])
    expect(run.failed[0]).toMatchObject({ underlying: 'ETH', permanent: true })
    expect(run.failed[0].error).toMatch(/refusing/)
  })
})

describe('the sweep reports each book apart', () => {
  it('gives every book its own cursor and its own due list', async () => {
    chain({ XLM: 2, BTC: 1 })
    const report = await sweep.sweepOnce({ dryRun: true })

    expect(report.books.map((b) => b.underlying)).toEqual(['XLM', 'BTC'])
    expect(report.books.find((b) => b.underlying === 'XLM')!.scan.nextId).toBe(2)
    expect(report.books.find((b) => b.underlying === 'BTC')!.scan.nextId).toBe(1)
    expect(report.books.find((b) => b.underlying === 'BTC')!.due).toHaveLength(1)
  })

  it('keeps sweeping the other books when one cannot be scanned', async () => {
    chain({ XLM: 1, BTC: 1 })
    getVaultStats.mockImplementation(async (asset: any) => {
      if (asset.symbol === 'BTC') throw new Error('rpc unwell')
      return { nextId: 1 } as any
    })

    const report = await sweep.sweepOnce({ dryRun: true })
    const btc = report.books.find((b) => b.underlying === 'BTC')!
    const xlm = report.books.find((b) => b.underlying === 'XLM')!

    expect(btc.error).toMatch(/rpc unwell/)
    expect(btc.due).toEqual([])
    // XLM's book was still walked, and says so rather than reading as clean.
    expect(xlm.error).toBeUndefined()
    expect(xlm.due).toHaveLength(1)
  })

  it('settles across books in one run, each naming its own', async () => {
    chain({ XLM: 1, BTC: 1 })
    const report = await sweep.sweepOnce({ runnerSecret: signer.secret() })

    expect(report.settled.map((s) => `${s.underlying}#${s.id}`)).toEqual([
      'XLM#0',
      'BTC#0',
    ])
  })
})

describe('position identity', () => {
  it('distinguishes the same id in two books', () => {
    expect(settlement.positionKey('XLM', 3)).not.toBe(settlement.positionKey('BTC', 3))
  })
})
