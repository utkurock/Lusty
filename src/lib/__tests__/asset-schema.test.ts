import { describe, it, expect, afterEach } from 'vitest'
import { StrKey } from '@stellar/stellar-sdk'
import {
  declare,
  resolveNumber,
  resolveText,
  type AssetDeclaration,
} from '../assets/schema'

// Synthetic addresses: well-formed strkeys naming nothing deployed.
const VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x21))
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 0x22))
const CASH = StrKey.encodeContract(Buffer.alloc(32, 0x23))
const ISSUER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x24))

const touched: string[] = []
function setEnv(key: string, value: string) {
  touched.push(key)
  process.env[key] = value
}
afterEach(() => {
  for (const key of touched.splice(0)) delete process.env[key]
})

/**
 * A declaration for an asset the codebase has never heard of. That it compiles
 * at all is the point of the commit: under the closed union this file would
 * not build until `UnderlyingSymbol` gained 'ZZZ'.
 */
function declaration(
  overrides: Partial<AssetDeclaration> = {}
): AssetDeclaration {
  return {
    symbol: 'ZZZ',
    name: 'Test Underlying',
    slug: 'zzz',
    icon: '◆',
    contracts: { vault: VAULT, token: TOKEN, cash: CASH },
    feedSymbol: 'ZZZ',
    binanceSymbol: 'ZZZUSDT',
    coingeckoId: 'test-underlying',
    collateral: { kind: 'native' },
    unitDecimals: 7,
    displayDecimals: 4,
    strike: { callOtm: [1.05], putOtm: [0.95], tickFraction: 0.02 },
    expiry: { openExpiries: 2, minDaysToExpiry: 1, tenorDays: 14 },
    envelope: {
      minSize: 1,
      maxSize: 50,
      userEpochCall: 50,
      maxSizeCash: 500,
      userEpochPutUsd: 500,
      callMonthlyCap: 900,
      putMonthlyCapUsd: 9_000,
    },
    onchainLimits: {
      maxPositionCall: 50,
      maxPositionPut: 500,
      maxExpiryCall: 900,
      maxExpiryPut: 9_000,
      maxPremiumBps: 2_000,
    },
    ...overrides,
  }
}

describe('declare — an asset is data, not a type edit', () => {
  it('lists a symbol nothing in the codebase names', () => {
    const a = declare(declaration())
    expect(a.symbol).toBe('ZZZ')
    expect(a.enabled).toBe(true)
    expect(a.contracts).toEqual({ vault: VAULT, token: TOKEN, cash: CASH })
  })

  it('normalizes the symbol so a lookup cannot miss on case or spacing', () => {
    expect(declare(declaration({ symbol: ' zzz ' })).symbol).toBe('ZZZ')
  })

  it('carries the strike and expiry parameters through untouched', () => {
    const a = declare(declaration())
    expect(a.strike.callOtm).toEqual([1.05])
    expect(a.strike.tickFraction).toBe(0.02)
    expect(a.expiry).toEqual({
      openExpiries: 2,
      minDaysToExpiry: 1,
      tenorDays: 14,
    })
  })
})

describe('declare — gating', () => {
  it('gates an asset with nowhere to settle', () => {
    for (const missing of ['vault', 'token', 'cash'] as const) {
      const contracts = { vault: VAULT, token: TOKEN, cash: CASH, [missing]: '' }
      expect(declare(declaration({ contracts })).enabled).toBe(false)
    }
  })

  it('gates issued collateral until somebody anchors it', () => {
    const unanchored = declare(
      declaration({
        collateral: { kind: 'issued', code: 'ZZZ', issuer: null },
      })
    )
    expect(unanchored.stellarAsset).toEqual({
      kind: 'issued',
      code: 'ZZZ',
      issuer: null,
    })
    expect(unanchored.enabled).toBe(false)

    const anchored = declare(
      declaration({
        collateral: { kind: 'issued', code: 'ZZZ', issuer: ISSUER },
      })
    )
    expect(anchored.enabled).toBe(true)
  })
})

describe('resolving a declared field against the environment', () => {
  it('takes the fallback when the key is unset', () => {
    expect(resolveText({ env: 'LUSTY_TEST_TEXT', fallback: 'fall' })).toBe('fall')
    expect(resolveNumber({ env: 'LUSTY_TEST_NUM', fallback: 7 })).toBe(7)
  })

  it('takes the environment when it carries something', () => {
    setEnv('LUSTY_TEST_TEXT', '  spaced  ')
    setEnv('LUSTY_TEST_NUM', '42')
    expect(resolveText({ env: 'LUSTY_TEST_TEXT', fallback: 'fall' })).toBe('spaced')
    expect(resolveNumber({ env: 'LUSTY_TEST_NUM', fallback: 7 })).toBe(42)
  })

  it('reads a blank key as absent, not as an address of nothing', () => {
    setEnv('LUSTY_TEST_TEXT', '   ')
    expect(resolveText({ env: 'LUSTY_TEST_TEXT', fallback: 'fall' })).toBe('fall')
  })

  it('takes the first key that is set, so a rename keeps both spellings', () => {
    setEnv('LUSTY_TEST_OLD', 'old')
    const keys = { env: ['LUSTY_TEST_NEW', 'LUSTY_TEST_OLD'], fallback: '' }
    expect(resolveText(keys)).toBe('old')
    setEnv('LUSTY_TEST_NEW', 'new')
    expect(resolveText(keys)).toBe('new')
  })

  it('refuses a cap that is not a positive number', () => {
    for (const bad of ['0', '-1', 'nine', '']) {
      setEnv('LUSTY_TEST_NUM', bad)
      expect(resolveNumber({ env: 'LUSTY_TEST_NUM', fallback: 7 })).toBe(7)
    }
  })

  it('resolves a whole declaration from the environment', () => {
    setEnv('LUSTY_TEST_VAULT', VAULT)
    setEnv('LUSTY_TEST_CAP', '1234')
    const a = declare(
      declaration({
        contracts: {
          vault: { env: 'LUSTY_TEST_VAULT', fallback: '' },
          token: TOKEN,
          cash: CASH,
        },
        envelope: {
          ...declaration().envelope,
          callMonthlyCap: { env: 'LUSTY_TEST_CAP', fallback: 1 },
        },
      })
    )
    expect(a.contracts.vault).toBe(VAULT)
    expect(a.callMonthlyCap).toBe(1234)
    expect(a.enabled).toBe(true)
  })
})
