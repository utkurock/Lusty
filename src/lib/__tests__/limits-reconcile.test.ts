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

vi.mock('@/lib/vault-contract', () => ({
  getVaultLimits: async () => {
    reads += 1
    if (readFails) throw new Error(readFails)
    return onchain
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
