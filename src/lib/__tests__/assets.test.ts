import { describe, it, expect } from 'vitest'
import {
  XLM,
  BTC,
  allUnderlyings,
  enabledUnderlyings,
  resolveUnderlying,
  underlying,
} from '../assets'

// Env unset in the test runner, so BTC_ANCHOR_ISSUER is null and BTC is gated.

describe('registry — what is declared vs what is tradeable', () => {
  it('declares both underlyings', () => {
    expect(allUnderlyings().map((a) => a.symbol)).toEqual(['XLM', 'BTC'])
  })

  it('keeps XLM live', () => {
    expect(XLM.enabled).toBe(true)
    expect(enabledUnderlyings().map((a) => a.symbol)).toContain('XLM')
  })

  it('gates BTC until an anchor issues the asset it would escrow', () => {
    expect(BTC.stellarAsset).toEqual({
      kind: 'issued',
      code: 'BTC',
      issuer: null,
    })
    expect(BTC.enabled).toBe(false)
    expect(enabledUnderlyings().map((a) => a.symbol)).not.toContain('BTC')
  })
})

describe('registry — separate books', () => {
  it('prices each underlying off its own Reflector feed', () => {
    expect(XLM.feedSymbol).toBe('XLM')
    expect(BTC.feedSymbol).toBe('BTC')
    expect(XLM.feedSymbol).not.toBe(BTC.feedSymbol)
  })

  it('quotes each off its own Binance ticker', () => {
    expect(XLM.binanceSymbol).toBe('XLMUSDT')
    expect(BTC.binanceSymbol).toBe('BTCUSDT')
  })

  it('gives each its own capacity, not a share of one budget', () => {
    expect(BTC.callMonthlyCap).not.toBe(XLM.callMonthlyCap)
    for (const a of allUnderlyings()) {
      expect(a.callMonthlyCap).toBeGreaterThan(0)
      expect(a.putMonthlyCapUsd).toBeGreaterThan(0)
      expect(a.minSize).toBeGreaterThan(0)
    }
  })

  it('sizes each in units that mean something for it', () => {
    // 100 XLM is a position; 100 BTC is not a size anyone writes.
    expect(XLM.minSize).toBeGreaterThan(BTC.minSize)
    expect(BTC.displayDecimals).toBeGreaterThan(XLM.displayDecimals)
  })
})

describe('resolveUnderlying — untrusted input', () => {
  it('accepts a slug or symbol in any case', () => {
    expect(resolveUnderlying('xlm')).toBe(XLM)
    expect(resolveUnderlying('XLM')).toBe(XLM)
    expect(resolveUnderlying('  Xlm ')).toBe(XLM)
  })

  it('refuses a gated asset even when its name is spelled correctly', () => {
    expect(resolveUnderlying('btc')).toBeNull()
  })

  it('refuses anything unknown or non-string', () => {
    expect(resolveUnderlying('ETH')).toBeNull()
    expect(resolveUnderlying('')).toBeNull()
    expect(resolveUnderlying(undefined)).toBeNull()
    expect(resolveUnderlying(7)).toBeNull()
  })

  it('never resolves to a prototype key', () => {
    expect(resolveUnderlying('constructor')).toBeNull()
    expect(resolveUnderlying('toString')).toBeNull()
  })
})

describe('underlying() — direct lookup', () => {
  it('returns the same object the named exports point at', () => {
    expect(underlying('XLM')).toBe(XLM)
    expect(underlying('BTC')).toBe(BTC)
  })
})
