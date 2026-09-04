import { describe, it, expect } from 'vitest'
import {
  toTokenUnits,
  fromTokenUnits,
  toOracleScale,
  fromOracleScale,
  coveredUnits,
  settlementPayout,
  sideFromContract,
} from '../vault-contract'

// The contract's own fixtures, so a drift between these scales and
// contracts/vault/src/test.rs shows up as a failing test rather than as a
// mispriced position.
const COLLATERAL_100_XLM = 1000000000n // 100 XLM in stroops
const STRIKE_25_CENTS = 25000000000000n // $0.25 at 14 decimals

describe('token scaling', () => {
  it('matches the contract fixtures', () => {
    expect(toTokenUnits(100)).toBe(COLLATERAL_100_XLM)
    expect(fromTokenUnits(COLLATERAL_100_XLM)).toBe(100)
  })

  it('keeps the last stroop on amounts too large for float math', () => {
    // 12_345_678.9012345 × 1e7 is past 2^53, so multiplying would round.
    expect(toTokenUnits(12_345_678.9012345)).toBe(123456789012345n)
  })

  it('resolves sub-stroop input to the nearest stroop', () => {
    expect(toTokenUnits(1.00000004)).toBe(10000000n)
    expect(toTokenUnits(1.00000006)).toBe(10000001n)
    expect(toTokenUnits(0.00000004)).toBe(0n)
  })

  it('refuses negative and non-finite amounts', () => {
    expect(() => toTokenUnits(-1)).toThrow()
    expect(() => toTokenUnits(NaN)).toThrow()
    expect(() => toTokenUnits(Infinity)).toThrow()
  })
})

describe('oracle scaling', () => {
  it('matches the contract fixtures', () => {
    expect(toOracleScale(0.25)).toBe(STRIKE_25_CENTS)
    expect(fromOracleScale(STRIKE_25_CENTS)).toBe(0.25)
  })

  it('round-trips a realistic strike', () => {
    expect(fromOracleScale(toOracleScale(0.2534))).toBeCloseTo(0.2534, 10)
  })
})

describe('coveredUnits', () => {
  it('covers a call one-for-one with its collateral', () => {
    expect(coveredUnits('call', 100, 0.25)).toBe(100)
  })

  it('covers a put with what its cash buys at the strike', () => {
    // The contract's put fixture: $25 secures 100 XLM at $0.25.
    expect(coveredUnits('put', 25, 0.25)).toBe(100)
  })

  it('refuses a non-positive strike', () => {
    expect(() => coveredUnits('put', 25, 0)).toThrow()
  })
})

describe('side discriminant', () => {
  it('maps the contract Kind values', () => {
    expect(sideFromContract(0)).toBe('call')
    expect(sideFromContract(1)).toBe('put')
  })

  it('falls back to call for an unknown discriminant', () => {
    // v2 events predate the field; an absent kind must not read as a put.
    expect(sideFromContract(7)).toBe('call')
  })
})

// What settlement paid, and in which token.
//
// This is the figure a writer checks their wallet against, so it is asserted
// against the contract's own rule rather than against a rounded expectation:
// an assigned call pays amount x strike in cash, an assigned put pays
// amount / strike in the underlying, and either kept returns the escrow.
describe('settlementPayout', () => {
  const call = { side: 'call' as const, collateral: 10_000, strike: 0.168 }
  const put = { side: 'put' as const, collateral: 1_680, strike: 0.168 }

  it('says nothing about a position that has not settled', () => {
    expect(settlementPayout({ ...call, outcome: 'open' })).toBeNull()
  })

  it('pays an assigned call in cash, at the strike', () => {
    // 10,000 x $0.168 — the case that started this: the collateral does not
    // come back, cash does, and the two are different tokens.
    expect(settlementPayout({ ...call, outcome: 'assigned' })).toEqual({
      amount: 1_680,
      asset: 'LUSD',
    })
  })

  it('returns the escrowed XLM when a call is not assigned', () => {
    expect(settlementPayout({ ...call, outcome: 'kept' })).toEqual({
      amount: 10_000,
      asset: 'XLM',
    })
  })

  it('delivers the underlying when a put is assigned', () => {
    expect(settlementPayout({ ...put, outcome: 'assigned' })).toEqual({
      amount: 10_000,
      asset: 'XLM',
    })
  })

  it('returns the escrowed cash when a put is not assigned', () => {
    expect(settlementPayout({ ...put, outcome: 'kept' })).toEqual({
      amount: 1_680,
      asset: 'LUSD',
    })
  })

  it('truncates to the stroop the way the contract does', () => {
    // 3.3333333 XLM at $0.3333333: the exact product has more precision than
    // a 7-decimal token can hold, and the contract keeps the whole stroops.
    const p = settlementPayout({
      side: 'call',
      collateral: 3.3333333,
      strike: 0.3333333,
      outcome: 'assigned',
    })
    // 33,333,333 stroops x 0.3333333 = 11,111,109.88... stroops; the
    // fraction is dropped, not rounded up.
    expect(p).toEqual({ amount: 1.1111109, asset: 'LUSD' })
  })

  it('does not divide by a zero strike', () => {
    expect(
      settlementPayout({ side: 'put', collateral: 100, strike: 0, outcome: 'assigned' })
    ).toEqual({ amount: 0, asset: 'XLM' })
  })
})
