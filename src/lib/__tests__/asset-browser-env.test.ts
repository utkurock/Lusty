import { describe, it, expect, afterEach } from 'vitest'
import { BROWSER_ENV, DECLARATIONS } from '../assets/config'
import { declaredEnvKeys, resolveText, resolveNumber } from '../assets/schema'

// The one thing about the registry that nothing else here can check.
// ==================================================================
// A declaration names its environment keys as data. That is what lets an
// asset be added without touching code, and it is also why the bundler cannot
// see them: it substitutes `process.env.NEXT_PUBLIC_X` where it is written out
// by name, and a lookup by variable is not written out by name.
//
// So the public keys are listed literally in config.ts, and this asserts the
// list still matches what the declarations ask for. It is the only place the
// mismatch is visible: this runner and `next build` both have a real
// `process.env`, so both resolve every key correctly and neither notices. Only
// the browser gets nothing, gates every asset, and disagrees with the server
// it just hydrated.

describe('the public keys reach the browser', () => {
  const declared = new Set(
    DECLARATIONS.flatMap(declaredEnvKeys).filter((k) =>
      k.startsWith('NEXT_PUBLIC_')
    )
  )
  const inlined = new Set(Object.keys(BROWSER_ENV))

  it('inlines every public key the declarations name', () => {
    const missing = [...declared].filter((k) => !inlined.has(k))
    expect(missing, 'add these to BROWSER_ENV in lib/assets/config.ts').toEqual([])
  })

  it('inlines nothing the declarations stopped naming', () => {
    const stale = [...inlined].filter((k) => !declared.has(k))
    expect(stale, 'remove these from BROWSER_ENV in lib/assets/config.ts').toEqual([])
  })

  it('names only public keys, since server keys never reach the bundle', () => {
    expect([...inlined].filter((k) => !k.startsWith('NEXT_PUBLIC_'))).toEqual([])
  })
})

describe('the inlined table is what resolution reads first', () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_LUSTY_TEST
  })

  it('prefers the substituted value over the ambient one', () => {
    process.env.NEXT_PUBLIC_LUSTY_TEST = 'ambient'
    const declaredField = { env: 'NEXT_PUBLIC_LUSTY_TEST', fallback: 'fall' }
    expect(resolveText(declaredField, { NEXT_PUBLIC_LUSTY_TEST: 'inlined' })).toBe(
      'inlined'
    )
  })

  it('falls through to the ambient one for a key nobody inlined', () => {
    process.env.NEXT_PUBLIC_LUSTY_TEST = 'ambient'
    expect(
      resolveText({ env: 'NEXT_PUBLIC_LUSTY_TEST', fallback: 'fall' }, {})
    ).toBe('ambient')
  })

  it('treats an inlined blank as absent, the way an unset key is', () => {
    expect(
      resolveText({ env: 'NEXT_PUBLIC_LUSTY_TEST', fallback: 'fall' }, {
        NEXT_PUBLIC_LUSTY_TEST: '',
      })
    ).toBe('fall')
    expect(
      resolveNumber({ env: 'NEXT_PUBLIC_LUSTY_TEST', fallback: 7 }, {
        NEXT_PUBLIC_LUSTY_TEST: undefined,
      })
    ).toBe(7)
  })
})

describe('declaredEnvKeys — read out of the declaration itself', () => {
  it('finds the keys on every branch of a declaration', () => {
    const keys = declaredEnvKeys(DECLARATIONS[1])
    expect(keys).toContain('NEXT_PUBLIC_VAULT_CONTRACT_BTC')
    expect(keys).toContain('NEXT_PUBLIC_BTC_ANCHOR_ISSUER')
    expect(keys).toContain('VAULT_CALL_MONTHLY_CAP_BTC')
  })

  it('takes every spelling where a field names more than one', () => {
    const keys = declaredEnvKeys(DECLARATIONS[0])
    expect(keys).toContain('NEXT_PUBLIC_VAULT_CONTRACT')
    expect(keys).toContain('VAULT_CONTRACT')
  })
})
