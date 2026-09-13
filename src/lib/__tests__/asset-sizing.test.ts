import { describe, it, expect } from 'vitest'
import { XLM, BTC } from '../assets'
import { formatUnits } from '../utils'

// Sizes and decimals belong to the asset.
// =======================================
// Every deposit bound on the earn screen used to be a module constant named
// after XLM: MIN_DEPOSIT_XLM, MAX_DEPOSIT_XLM, MAX_USER_EPOCH_CALL_XLM. Read on
// a BTC screen those are not tight or loose, they are meaningless — a 10,000
// maximum is two thousand times the whole instance's per-expiry cap, and a
// wallet allowance of 10,000 can never bind on a book that holds five.

describe('the registry sizes each book', () => {
  it('keeps XLM on the numbers it has always used', () => {
    // The point of moving them is that nothing about XLM changes.
    expect(XLM.minSize).toBe(100)
    expect(XLM.maxSize).toBe(10_000)
    expect(XLM.userEpochCall).toBe(10_000)
    expect(XLM.userEpochPutUsd).toBe(10_000)
  })

  it('sizes BTC in BTC', () => {
    expect(BTC.minSize).toBe(0.001)
    expect(BTC.maxSize).toBe(0.05)
    // The put leg is in cash, so its bound is a dollar figure either way.
    expect(BTC.maxSizeCash).toBe(1_500)
  })

  it('gives BTC enough decimals to express its own minimum', () => {
    // The failure this prevents: a minimum of 0.001 rendered at two decimals
    // reads as "0 BTC", which is not a minimum anybody can meet — and the
    // largest position allowed, 0.05, reads as zero too.
    expect(formatUnits(BTC.minSize, 'BTC', BTC.displayDecimals)).toBe('0.001 BTC')
    expect(formatUnits(BTC.maxSize, 'BTC', BTC.displayDecimals)).toBe('0.05 BTC')
    expect(formatUnits(BTC.minSize, 'BTC', XLM.displayDecimals)).toBe('0 BTC')
  })

  it("leaves XLM's own formatting alone", () => {
    expect(formatUnits(1234.5, 'XLM', XLM.displayDecimals)).toBe('1,234.5 XLM')
  })
})
