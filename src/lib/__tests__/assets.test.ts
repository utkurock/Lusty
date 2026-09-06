import { describe, it, expect, beforeAll, vi } from 'vitest'

// The registry reads its contract ids at module load, so the env goes in
// before the import.

const XLM_VAULT = 'CBJZGTCF2PJVHX2BNFTFZ2L2LX6DWD5JMTLHNCVYTSOD3BLVSXZRUCJZ'

type Registry = typeof import('../assets')
let reg: Registry

beforeAll(async () => {
  process.env.NEXT_PUBLIC_VAULT_CONTRACT = XLM_VAULT
  reg = await import('../assets')
})

// BTC_ANCHOR_ISSUER and VAULT_CONTRACT_BTC stay unset, so BTC is gated twice.

describe('registry — what is declared vs what is tradeable', () => {
  it('declares both underlyings', () => {
    expect(reg.allUnderlyings().map((a) => a.symbol)).toEqual(['XLM', 'BTC'])
  })

  it('keeps XLM live', () => {
    expect(reg.XLM.enabled).toBe(true)
    expect(reg.enabledUnderlyings().map((a) => a.symbol)).toContain('XLM')
  })

  it('gates BTC until an anchor issues the asset it would escrow', () => {
    expect(reg.BTC.stellarAsset).toEqual({
      kind: 'issued',
      code: 'BTC',
      issuer: null,
    })
    expect(reg.BTC.enabled).toBe(false)
    expect(reg.enabledUnderlyings().map((a) => a.symbol)).not.toContain('BTC')
  })

  it('gates an underlying with nowhere to settle, anchor or not', async () => {
    expect(reg.BTC.contracts.vault).toBe('')

    const issuer = 'GDUKMGUGDZQK6YHYA5Z6AY2G4XDSZPSZ3SW5UN3ARVMO6QSRDWP5YLEX'
    process.env.NEXT_PUBLIC_BTC_ANCHOR_ISSUER = issuer
    vi.resetModules()
    const anchored: Registry = await import('../assets')
    delete process.env.NEXT_PUBLIC_BTC_ANCHOR_ISSUER

    expect(anchored.BTC.stellarAsset).toMatchObject({ issuer })
    expect(anchored.BTC.enabled).toBe(false)
    expect(anchored.vaultInstances()).not.toContain('')
  })
})

describe('registry — separate books', () => {
  it('prices each underlying off its own Reflector feed', () => {
    expect(reg.XLM.feedSymbol).toBe('XLM')
    expect(reg.BTC.feedSymbol).toBe('BTC')
    expect(reg.XLM.feedSymbol).not.toBe(reg.BTC.feedSymbol)
  })

  it('quotes each off its own Binance ticker', () => {
    expect(reg.XLM.binanceSymbol).toBe('XLMUSDT')
    expect(reg.BTC.binanceSymbol).toBe('BTCUSDT')
  })

  it('settles each in a vault instance of its own', () => {
    // BTC must not inherit XLM's instance, which holds XLM's escrow.
    expect(reg.XLM.contracts.vault).toBe(XLM_VAULT)
    expect(reg.BTC.contracts.vault).not.toBe(reg.XLM.contracts.vault)
  })

  it('escrows a different asset for each, and pays premiums in one cash', () => {
    expect(reg.XLM.contracts.token).not.toBe(reg.BTC.contracts.token)
    expect(reg.XLM.contracts.cash).toBe(reg.BTC.contracts.cash)
    expect(reg.XLM.contracts.cash).not.toBe('')
  })

  it('gives each its own capacity, not a share of one budget', () => {
    expect(reg.BTC.callMonthlyCap).not.toBe(reg.XLM.callMonthlyCap)
    for (const a of reg.allUnderlyings()) {
      expect(a.callMonthlyCap).toBeGreaterThan(0)
      expect(a.putMonthlyCapUsd).toBeGreaterThan(0)
      expect(a.minSize).toBeGreaterThan(0)
    }
  })

  it('sizes each in units that mean something for it', () => {
    // 100 XLM is a position; 100 BTC is not a size anyone writes.
    expect(reg.XLM.minSize).toBeGreaterThan(reg.BTC.minSize)
    expect(reg.BTC.displayDecimals).toBeGreaterThan(reg.XLM.displayDecimals)
  })
})

describe('vaultInstances — what the event indexer streams', () => {
  it('lists the deployed instances and nothing else', () => {
    expect(reg.vaultInstances()).toEqual([XLM_VAULT])
  })

  it('never repeats an instance', () => {
    const ids = reg.vaultInstances()
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('resolveUnderlying — untrusted input', () => {
  it('accepts a slug or symbol in any case', () => {
    expect(reg.resolveUnderlying('xlm')).toBe(reg.XLM)
    expect(reg.resolveUnderlying('XLM')).toBe(reg.XLM)
    expect(reg.resolveUnderlying('  Xlm ')).toBe(reg.XLM)
  })

  it('refuses a gated asset even when its name is spelled correctly', () => {
    expect(reg.resolveUnderlying('btc')).toBeNull()
  })

  it('refuses anything unknown or non-string', () => {
    expect(reg.resolveUnderlying('ETH')).toBeNull()
    expect(reg.resolveUnderlying('')).toBeNull()
    expect(reg.resolveUnderlying(undefined)).toBeNull()
    expect(reg.resolveUnderlying(7)).toBeNull()
  })

  it('never resolves to a prototype key', () => {
    expect(reg.resolveUnderlying('constructor')).toBeNull()
    expect(reg.resolveUnderlying('toString')).toBeNull()
  })
})

describe('underlying() — direct lookup', () => {
  it('returns the same object the named exports point at', () => {
    expect(reg.underlying('XLM')).toBe(reg.XLM)
    expect(reg.underlying('BTC')).toBe(reg.BTC)
  })
})
