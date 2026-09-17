import { describe, it, expect, afterEach, vi } from 'vitest'
import { StrKey } from '@stellar/stellar-sdk'
import { declare, type AssetDeclaration } from '../assets/schema'
import { validateAsset } from '../assets/validate'

const VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x31))
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 0x32))
const CASH = StrKey.encodeContract(Buffer.alloc(32, 0x33))
const ISSUER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x34))

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
    strike: { callOtm: [1.02, 1.06], putOtm: [0.98, 0.94], tickFraction: 0.01 },
    expiry: { openExpiries: 3, minDaysToExpiry: 2, tenorDays: 7 },
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

/** Fields flagged when this declaration is resolved. */
function fieldsFor(overrides: Partial<AssetDeclaration>): string[] {
  return declare(declaration(overrides)).issues.map((i) => i.field)
}

describe('a complete declaration is servable', () => {
  it('reports nothing and stays enabled', () => {
    const a = declare(declaration())
    expect(a.issues).toEqual([])
    expect(a.enabled).toBe(true)
    expect(validateAsset(a)).toEqual([])
  })
})

describe('what is absent is unconfigured, what is wrong is invalid', () => {
  it('calls a missing contract unconfigured and a malformed one invalid', () => {
    const absent = declare(
      declaration({ contracts: { vault: '', token: TOKEN, cash: CASH } })
    ).issues
    expect(absent).toHaveLength(1)
    expect(absent[0]).toMatchObject({ kind: 'unconfigured', field: 'contracts.vault' })

    const malformed = declare(
      declaration({ contracts: { vault: 'NOT-A-CONTRACT', token: TOKEN, cash: CASH } })
    ).issues
    expect(malformed).toHaveLength(1)
    expect(malformed[0]).toMatchObject({ kind: 'invalid', field: 'contracts.vault' })
  })

  it('says the same about an anchor that is missing versus misspelled', () => {
    const unanchored = declare(
      declaration({ collateral: { kind: 'issued', code: 'ZZZ', issuer: null } })
    ).issues
    expect(unanchored).toEqual([
      expect.objectContaining({ kind: 'unconfigured', field: 'stellarAsset.issuer' }),
    ])

    const wrong = declare(
      declaration({ collateral: { kind: 'issued', code: 'ZZZ', issuer: VAULT } })
    ).issues
    expect(wrong).toEqual([
      expect.objectContaining({ kind: 'invalid', field: 'stellarAsset.issuer' }),
    ])

    const anchored = declare(
      declaration({ collateral: { kind: 'issued', code: 'ZZZ', issuer: ISSUER } })
    )
    expect(anchored.enabled).toBe(true)
  })
})

describe('dropping a required field takes the asset offline', () => {
  const cases: Array<[string, Partial<AssetDeclaration>, string]> = [
    ['no vault', { contracts: { vault: '', token: TOKEN, cash: CASH } }, 'contracts.vault'],
    ['no token', { contracts: { vault: VAULT, token: '', cash: CASH } }, 'contracts.token'],
    ['no cash', { contracts: { vault: VAULT, token: TOKEN, cash: '' } }, 'contracts.cash'],
    ['no feed', { feedSymbol: '' }, 'feedSymbol'],
    ['no market', { binanceSymbol: '' }, 'binanceSymbol'],
    ['no vol source', { coingeckoId: '' }, 'coingeckoId'],
    ['no name', { name: '  ' }, 'name'],
    ['unusable slug', { slug: 'Not A Slug' }, 'slug'],
    ['unusable symbol', { symbol: 'zz zz' }, 'symbol'],
  ]

  for (const [label, override, field] of cases) {
    it(label, () => {
      const a = declare(declaration(override))
      expect(a.enabled).toBe(false)
      expect(a.issues.map((i) => i.field)).toContain(field)
    })
  }
})

describe('a bound that contradicts another is caught before it is offered', () => {
  it('refuses a largest position below the smallest one', () => {
    expect(
      fieldsFor({ envelope: { ...declaration().envelope, maxSize: 0.5 } })
    ).toContain('maxSize')
  })

  it("refuses an epoch allowance a single position would not fit in", () => {
    expect(
      fieldsFor({ envelope: { ...declaration().envelope, userEpochCall: 10 } })
    ).toContain('userEpochCall')
    expect(
      fieldsFor({ envelope: { ...declaration().envelope, userEpochPutUsd: 10 } })
    ).toContain('userEpochPutUsd')
  })

  it('refuses a month of capacity smaller than one position', () => {
    expect(
      fieldsFor({ envelope: { ...declaration().envelope, callMonthlyCap: 10 } })
    ).toContain('callMonthlyCap')
    expect(
      fieldsFor({ envelope: { ...declaration().envelope, putMonthlyCapUsd: 10 } })
    ).toContain('putMonthlyCapUsd')
  })

  it('refuses a cap that is zero, negative or not a number', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(
        fieldsFor({ envelope: { ...declaration().envelope, minSize: bad } })
      ).toContain('minSize')
    }
  })

  it('refuses a premium ceiling above the collateral behind it', () => {
    expect(
      fieldsFor({
        onchainLimits: { ...declaration().onchainLimits, maxPremiumBps: 12_000 },
      })
    ).toContain('onchainLimits.maxPremiumBps')
  })

  it('refuses showing more precision than the book carries', () => {
    expect(fieldsFor({ displayDecimals: 9 })).toContain('displayDecimals')
  })
})

describe('the ladder and the schedule', () => {
  it('refuses a ladder with no rungs', () => {
    const strike = { ...declaration().strike, callOtm: [] }
    expect(fieldsFor({ strike })).toContain('strike.callOtm')
  })

  it('refuses rungs on the wrong side of the money', () => {
    expect(
      fieldsFor({ strike: { ...declaration().strike, callOtm: [0.98, 1.06] } })
    ).toContain('strike.callOtm')
    expect(
      fieldsFor({ strike: { ...declaration().strike, putOtm: [0.98, 1.02] } })
    ).toContain('strike.putOtm')
  })

  // The ladder maximum has to be at index 0 — pricing-server normalizes the
  // whole ladder against the nearest rung.
  it('refuses rungs that turn back toward the money', () => {
    expect(
      fieldsFor({ strike: { ...declaration().strike, callOtm: [1.06, 1.02] } })
    ).toContain('strike.callOtm')
    expect(
      fieldsFor({ strike: { ...declaration().strike, putOtm: [0.94, 0.98] } })
    ).toContain('strike.putOtm')
  })

  it('refuses a tick that is not a fraction of spot', () => {
    for (const bad of [0, 1, 2]) {
      expect(
        fieldsFor({ strike: { ...declaration().strike, tickFraction: bad } })
      ).toContain('strike.tickFraction')
    }
  })

  it('refuses a schedule with no open expiry', () => {
    expect(
      fieldsFor({ expiry: { ...declaration().expiry, openExpiries: 0 } })
    ).toContain('expiry.openExpiries')
    expect(
      fieldsFor({ expiry: { ...declaration().expiry, openExpiries: 1.5 } })
    ).toContain('expiry.openExpiries')
  })
})

// The registry, not one declaration: the point of gating rather than throwing
// is that one broken book leaves the others up.
describe('the registry under a broken declaration', () => {
  const XLM_VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x11))
  const BTC_VAULT = StrKey.encodeContract(Buffer.alloc(32, 0x12))
  const BTC_SAC = StrKey.encodeContract(Buffer.alloc(32, 0x13))
  const BTC_ISSUER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x14))

  const keys = [
    'NEXT_PUBLIC_VAULT_CONTRACT',
    'NEXT_PUBLIC_VAULT_CONTRACT_BTC',
    'NEXT_PUBLIC_BTC_CONTRACT',
    'NEXT_PUBLIC_BTC_ANCHOR_ISSUER',
    'VAULT_CALL_MONTHLY_CAP_BTC',
  ]

  function bothBooksConfigured() {
    process.env.NEXT_PUBLIC_VAULT_CONTRACT = XLM_VAULT
    process.env.NEXT_PUBLIC_VAULT_CONTRACT_BTC = BTC_VAULT
    process.env.NEXT_PUBLIC_BTC_CONTRACT = BTC_SAC
    process.env.NEXT_PUBLIC_BTC_ANCHOR_ISSUER = BTC_ISSUER
  }

  afterEach(() => {
    for (const k of keys) delete process.env[k]
    vi.resetModules()
  })

  async function load() {
    vi.resetModules()
    return import('../assets')
  }

  it('serves both books when both are configured', async () => {
    bothBooksConfigured()
    const reg = await load()
    expect(reg.enabledUnderlyings().map((a) => a.symbol)).toEqual(['XLM', 'BTC'])
    expect(reg.gatedUnderlyings()).toEqual([])
  })

  it('gates only the book whose capacity stops making sense', async () => {
    bothBooksConfigured()
    // A month of call capacity below one position: the screen would offer a
    // size the book has no room for.
    process.env.VAULT_CALL_MONTHLY_CAP_BTC = '0.001'
    const reg = await load()

    expect(reg.XLM.enabled).toBe(true)
    expect(reg.BTC.enabled).toBe(false)
    expect(reg.enabledUnderlyings().map((a) => a.symbol)).toEqual(['XLM'])
    expect(reg.resolveUnderlying('btc')).toBeNull()

    const gated = reg.gatedUnderlyings()
    expect(gated.map((g) => g.symbol)).toEqual(['BTC'])
    expect(gated[0].issues[0].kind).toBe('invalid')
    expect(gated[0].reasons.join(' ')).toMatch(/callMonthlyCap/)
  })

  it('still settles a gated book, because collateral has to come back', async () => {
    bothBooksConfigured()
    process.env.VAULT_CALL_MONTHLY_CAP_BTC = '0.001'
    const reg = await load()

    expect(reg.settleableUnderlyings().map((a) => a.symbol)).toEqual(['XLM', 'BTC'])
    expect(reg.settleableUnderlying('BTC')).toBe(reg.BTC)
    expect(reg.vaultInstances()).toEqual([XLM_VAULT, BTC_VAULT])
  })

  it('refuses to load a registry that declares one symbol twice', async () => {
    bothBooksConfigured()
    vi.resetModules()
    const { DECLARATIONS, BROWSER_ENV } = await import('../assets/config')
    vi.doMock('../assets/config', () => ({
      BROWSER_ENV,
      DECLARATIONS: [DECLARATIONS[0], { ...DECLARATIONS[0] }],
    }))
    await expect(import('../assets')).rejects.toThrow(/declared twice/)
    vi.doUnmock('../assets/config')
  })
})
