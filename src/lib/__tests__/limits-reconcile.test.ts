import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { StrKey } from '@stellar/stellar-sdk'
import { epochsPerMonth } from '../vault-state'

const XLM_VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x11))

// What the instance answers `limits()` with. Set per test, so drift is
// produced by moving the contract rather than by editing the registry, which
// is the direction the real failure arrives from.
let onchain: any
let reads = 0
let readFails: string | null = null
let paused = false
let pauseReads = 0
let pauseFails: string | null = null

vi.mock('@/lib/vault-contract', () => ({
  getVaultLimits: async () => {
    reads += 1
    if (readFails) throw new Error(readFails)
    return onchain
  },
  getVaultPaused: async () => {
    pauseReads += 1
    if (pauseFails) throw new Error(pauseFails)
    return paused
  },
}))

type Assets = typeof import('../assets')
type Limits = typeof import('../vault-limits')
let reg: Assets
let lim: Limits

/** The XLM book's own deployed limits, read off CBJZGTCF…UCJZ. */
const DEPLOYED = {
  maxPositionCall: 10_000,
  maxPositionPut: 10_000,
  maxExpiryCall: 500_000,
  maxExpiryPut: 500_000,
  maxOpenCall: null,
  maxOpenPut: null,
  maxPremiumBps: 2_000,
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_VAULT_CONTRACT = XLM_VAULT
  reg = await import('../assets')
  lim = await import('../vault-limits')
})

beforeEach(() => {
  onchain = { ...DEPLOYED }
  reads = 0
  readFails = null
  paused = false
  pauseReads = 0
  pauseFails = null
  lim.resetLimitsCache()
})

describe('compareLimits — the registry against the instance', () => {
  it('reconciles the XLM book as it is actually deployed', () => {
    expect(lim.compareLimits(reg.XLM, DEPLOYED)).toEqual([])
  })

  it('reconciles the BTC book as it is actually deployed', () => {
    expect(
      lim.compareLimits(reg.BTC, {
        maxPositionCall: 0.05,
        maxPositionPut: 1_500,
        maxExpiryCall: 5,
        maxExpiryPut: 150_000,
        maxOpenCall: null,
        maxOpenPut: null,
        maxPremiumBps: 2_000,
      })
    ).toEqual([])
  })

  it('catches a premium ceiling widened on chain', () => {
    const drift = lim.compareLimits(reg.XLM, { ...DEPLOYED, maxPremiumBps: 9_000 })
    expect(drift).toHaveLength(1)
    expect(drift[0].kind).toBe('declared')
    expect(drift[0].field).toBe('maxPremiumBps')
    expect(drift[0].detail).toContain('9000')
  })

  it('catches an instance deployed from a different position cap', () => {
    const drift = lim.compareLimits(reg.XLM, { ...DEPLOYED, maxPositionCall: 50_000 })
    expect(drift.map((d) => d.field)).toContain('maxPositionCall')
    expect(drift.every((d) => d.kind === 'declared')).toBe(true)
  })

  it('lets the envelope be tighter than the contract, which is the point of it', () => {
    // The XLM book quotes 50,000 of put collateral on an expiry against an
    // instance that would take 500,000. Ten times tighter, and not a fault.
    expect(lim.compareLimits(reg.XLM, DEPLOYED)).toEqual([])
  })

  it('refuses an envelope that would quote past the instance', () => {
    const wide = { ...reg.XLM, maxSize: 25_000 }
    const drift = lim.compareLimits(wide, DEPLOYED)
    expect(drift).toHaveLength(1)
    expect(drift[0].kind).toBe('envelope')
    expect(drift[0].field).toBe('maxSize')
    expect(drift[0].detail).toContain('25000')
  })

  it('compares the monthly capacity per expiry, not per month', () => {
    // The trap this check exists for. The envelope declares a month of
    // capacity and opens its own expiries against it, so the figure
    // that meets `max_expiry_call` is the quotient. Comparing the monthly
    // number instead would call this book three times looser than it is.
    const perExpiry = DEPLOYED.maxExpiryCall
    const epochs = epochsPerMonth(reg.XLM)
    const book = { ...reg.XLM, callMonthlyCap: perExpiry * epochs }
    expect(lim.compareLimits(book, DEPLOYED)).toEqual([])

    const overflowing = { ...reg.XLM, callMonthlyCap: perExpiry * epochs + 3 }
    const drift = lim.compareLimits(overflowing, DEPLOYED)
    expect(drift).toHaveLength(1)
    expect(drift[0].field).toBe('callMonthlyCap/epochs')
  })
})

describe('reconcileLimits — reading the instance', () => {
  it('passes a book whose records agree', async () => {
    const r = await lim.reconcileLimits(reg.XLM)
    expect(r.ok).toBe(true)
    expect(r.onchain).toEqual(DEPLOYED)
    expect(await lim.limitsRefusal(reg.XLM)).toBeNull()
  })

  it('refuses a book whose instance moved under it', async () => {
    onchain = { ...DEPLOYED, maxPositionCall: 1_000_000 }
    const refusal = await lim.limitsRefusal(reg.XLM)
    expect(refusal).toContain('XLM limits disagree with its vault')
    expect(refusal).toContain('1000000')
  })

  it('reads once and then serves the verdict from cache', async () => {
    await lim.reconcileLimits(reg.XLM, 1_000)
    await lim.reconcileLimits(reg.XLM, 2_000)
    expect(reads).toBe(1)
  })

  it('re-reads once the verdict is old enough', async () => {
    await lim.reconcileLimits(reg.XLM, 0)
    await lim.reconcileLimits(reg.XLM, 6 * 60_000)
    expect(reads).toBe(2)
  })

  it('keeps quoting on a transport failure, for as long as a clean read stands', async () => {
    await lim.reconcileLimits(reg.XLM, 0)
    readFails = 'rpc unreachable'
    const graced = await lim.reconcileLimits(reg.XLM, 30 * 60_000)
    expect(graced.ok).toBe(true)
    expect(graced.stale).toBe(true)
    expect(await lim.limitsRefusal(reg.XLM, 30 * 60_000)).toBeNull()
  })

  it('refuses once there is no read left to stand on', async () => {
    await lim.reconcileLimits(reg.XLM, 0)
    readFails = 'rpc unreachable'
    const expired = await lim.reconcileLimits(reg.XLM, 2 * 60 * 60_000)
    expect(expired.ok).toBe(false)
    expect(await lim.limitsRefusal(reg.XLM, 2 * 60 * 60_000)).toContain(
      'could not be read'
    )
  })

  it('refuses a book with no instance to reconcile against', async () => {
    const homeless = { ...reg.XLM, contracts: { ...reg.XLM.contracts, vault: '' } }
    expect(await lim.limitsRefusal(homeless)).toContain('could not be read')
    expect(reads).toBe(0)
  })
})

describe('compareLimits — the v6 open-interest caps', () => {
  // A v6 XLM book: the envelope's 1.5M a month and 150k USD a month both fit
  // under the caps across every open expiry.
  const V6 = { ...DEPLOYED, maxOpenCall: 1_500_000, maxOpenPut: 1_500_000 }
  const declaredV6 = () => ({
    ...reg.XLM,
    onchainLimits: { ...reg.XLM.onchainLimits, maxOpenCall: 1_500_000, maxOpenPut: 1_500_000 },
  })

  it('reconciles a v6 book whose declaration carries the caps', () => {
    expect(lim.compareLimits(declaredV6(), V6)).toEqual([])
  })

  it('catches a v5 declaration pointed at a v6 instance', () => {
    const drift = lim.compareLimits(reg.XLM, V6)
    expect(drift.map((d) => d.field).sort()).toEqual(['maxOpenCall', 'maxOpenPut'])
    expect(drift.every((d) => d.kind === 'declared')).toBe(true)
    expect(drift[0].detail).toContain('at none')
  })

  it('catches a v6 declaration pointed at a v5 instance', () => {
    const drift = lim.compareLimits(declaredV6(), DEPLOYED)
    expect(drift.map((d) => d.field).sort()).toEqual(['maxOpenCall', 'maxOpenPut'])
    expect(drift[0].detail).toContain('enforces none')
  })

  it('catches an open-interest cap moved on chain', () => {
    const drift = lim.compareLimits(declaredV6(), { ...V6, maxOpenPut: 9_000_000 })
    expect(drift).toHaveLength(1)
    expect(drift[0]).toMatchObject({ kind: 'declared', field: 'maxOpenPut', onchain: 9_000_000 })
  })

  it('refuses an envelope whose month would not fit under the open-interest cap', () => {
    const tight = { ...V6, maxOpenCall: 1_000_000 }
    const book = {
      ...reg.XLM,
      onchainLimits: { ...reg.XLM.onchainLimits, maxOpenCall: 1_000_000, maxOpenPut: 1_500_000 },
    }
    const drift = lim.compareLimits(book, tight)
    expect(drift).toHaveLength(1)
    expect(drift[0]).toMatchObject({ kind: 'envelope', field: 'callMonthlyCap', onchain: 1_000_000 })
  })
})

describe('readPause — the guardian\'s stop', () => {
  it('passes a book nobody paused', async () => {
    expect(await lim.pauseRefusal(reg.XLM, 0)).toBeNull()
  })

  it('refuses a paused book and says settlement goes on', async () => {
    paused = true
    const refusal = await lim.pauseRefusal(reg.XLM, 0)
    expect(refusal).toContain('XLM book is paused by its guardian')
    expect(refusal).toContain('still settle')
  })

  it('re-reads within a poll, far sooner than the limits', async () => {
    await lim.readPause(reg.XLM, 0)
    await lim.readPause(reg.XLM, 10_000)
    expect(pauseReads).toBe(1)
    paused = true
    expect((await lim.readPause(reg.XLM, 31_000)).paused).toBe(true)
    expect(pauseReads).toBe(2)
  })

  it('rides out a transport failure on the last reading, then refuses', async () => {
    await lim.readPause(reg.XLM, 0)
    pauseFails = 'rpc unreachable'
    expect(await lim.readPause(reg.XLM, 10 * 60_000)).toMatchObject({ paused: false, stale: true })
    expect(await lim.pauseRefusal(reg.XLM, 2 * 60 * 60_000)).toContain('could not be read')
  })

  it('refuses when the state was never read', async () => {
    pauseFails = 'rpc unreachable'
    expect(await lim.pauseRefusal(reg.XLM, 0)).toContain('could not be read')
  })
})
