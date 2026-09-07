import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { StrKey } from '@stellar/stellar-sdk'

const XLM_VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x11))
const BTC_VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x22))
const BTC_SAC = StrKey.encodeContract(Buffer.alloc(32, 0x33))
const BTC_ISSUER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x44))

/** A solvent book: nothing owed, nothing escrowed. */
const SOLVENT = {
  escrowedCall: 0,
  escrowedPut: 0,
  owedCall: 0,
  owedPut: 0,
  cashBalance: 1_000,
  underlyingBalance: 1_000,
  nextId: 0,
}

const stats: Record<string, typeof SOLVENT> = {}
const sold: Record<string, number> = {}

vi.mock('@/lib/vault-contract', () => ({
  getVaultStats: async (asset: any) => stats[asset.symbol] ?? SOLVENT,
}))
vi.mock('@/lib/vault-state', async (importOriginal) => {
  const real = await importOriginal<typeof import('../vault-state')>()
  return {
    ...real,
    computeOpenBuckets: async (_now: Date, asset: any) => [
      {
        expiryIso: '2026-10-02T16:00:00.000Z',
        dateKey: '2026-10-02',
        label: 'Oct_02',
        callXlm: sold[asset.symbol] ?? 0,
        putUsd: 0,
      },
    ],
  }
})
vi.mock('@/lib/settlement', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settlement')>()),
  scanForSettlement: async () => ({ candidates: [], pastDeadline: [] }),
}))
// Not what this file is about; keep them quiet and off the network.
vi.mock('@/lib/db', () => ({
  ensureSchema: async () => {},
  getPool: () => ({ query: async () => ({ rows: [{}] }) }),
}))
vi.mock('@/lib/lusd', () => ({ LUSD_DISTRIBUTOR: '' }))

let checks: typeof import('../monitor/checks')
let assets: typeof import('../assets')

beforeAll(async () => {
  process.env.NEXT_PUBLIC_VAULT_CONTRACT = XLM_VAULT
  process.env.NEXT_PUBLIC_VAULT_CONTRACT_BTC = BTC_VAULT
  process.env.NEXT_PUBLIC_BTC_ANCHOR_ISSUER = BTC_ISSUER
  process.env.NEXT_PUBLIC_BTC_CONTRACT = BTC_SAC
  vi.resetModules()
  assets = await import('../assets')
  checks = await import('../monitor/checks')
  // The vol check reaches Binance; it is not what these assertions are about.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 451 }) as any))
})

beforeEach(() => {
  for (const k of ['XLM', 'BTC']) {
    stats[k] = { ...SOLVENT }
    sold[k] = 0
  }
})

const titles = (alerts: { title: string }[]) => alerts.map((a) => a.title)

describe('a breach in one book alerts about that book only', () => {
  it('reports BTC insolvent without implicating XLM', async () => {
    // BTC owes more cash than its pool holds free.
    stats.BTC = { ...SOLVENT, cashBalance: 10, owedCall: 500 }

    const alerts = await checks.runMonitorChecks()
    const solvency = alerts.filter((a) => a.title.includes('cannot cover'))

    expect(titles(solvency)).toEqual(['BTC: vault cannot cover what it owes'])
    expect(alerts.every((a) => !a.title.startsWith('XLM: vault cannot cover'))).toBe(true)
  })

  it('reports XLM insolvent without implicating BTC', async () => {
    stats.XLM = { ...SOLVENT, underlyingBalance: 0, owedPut: 300 }

    const alerts = await checks.runMonitorChecks()
    const solvency = alerts.filter((a) => a.title.includes('cannot cover'))

    expect(titles(solvency)).toEqual(['XLM: vault cannot cover what it owes'])
  })

  it('does not warn on a full BTC book when only XLM is full', async () => {
    sold.XLM = assets.XLM.callMonthlyCap * 10

    const alerts = await checks.runMonitorChecks()
    const caps = alerts.filter((a) => a.title.includes('epochs full'))

    expect(titles(caps)).toEqual(['XLM: all covered-call epochs full'])
  })

  it('alerts on both when both are full, once each', async () => {
    sold.XLM = assets.XLM.callMonthlyCap * 10
    sold.BTC = assets.BTC.callMonthlyCap * 10

    const alerts = await checks.runMonitorChecks()
    const caps = alerts.filter((a) => a.title.includes('epochs full'))

    expect(titles(caps).sort()).toEqual([
      'BTC: all covered-call epochs full',
      'XLM: all covered-call epochs full',
    ])
  })
})

describe('the solvency check mirrors the contract s own guard', () => {
  it('does not lend the opposite kind s collateral against an obligation', async () => {
    // The cash balance covers owed_call on its own — but all of it is put
    // writers' escrow, which the contract will not lend against.
    stats.XLM = { ...SOLVENT, cashBalance: 500, escrowedPut: 500, owedCall: 400 }

    const alerts = await checks.runMonitorChecks()
    expect(titles(alerts)).toContain('XLM: vault cannot cover what it owes')
  })

  it('stays quiet when free balance exactly meets what is owed', async () => {
    stats.XLM = { ...SOLVENT, cashBalance: 900, escrowedPut: 500, owedCall: 400 }

    const alerts = await checks.runMonitorChecks()
    expect(titles(alerts)).not.toContain('XLM: vault cannot cover what it owes')
  })

  it('names the shortfall rather than only the fact', async () => {
    stats.BTC = { ...SOLVENT, cashBalance: 100, owedCall: 350 }

    const alerts = await checks.runMonitorChecks()
    const alert = alerts.find((a) => a.title === 'BTC: vault cannot cover what it owes')!
    expect(alert.fields).toContainEqual({
      label: 'call_shortfall_LUSD',
      value: '250.0000000',
    })
  })
})
