import { describe, it, expect } from 'vitest'
import { trustlinesRequired, classicAsset } from '../swap'
import { XLM, BTC, type UnderlyingAsset } from '../assets'
import { LUSD_CODE } from '../lusd'

const ISSUER = 'GB6274FEMTPWDEZ47P2YCXQ6JZCPRTHB5NMSFVPIUFB6MK5RXNBWZ2E2'

// Which trustlines a position needs before it is opened.
// =====================================================
// A trustline is permission to be paid. Every question here is really the same
// question asked of a different leg: when this position ends, what arrives in
// the writer's account, and can it?
//
// It never came up in Tranche 1 because the only two answers were cash, which
// the screen already established, and native XLM, which needs no trustline at
// all. An issued underlying makes the second answer a real one.

const codes = (a: Parameters<typeof trustlinesRequired>[0]) =>
  trustlinesRequired(a).map((t) => (t.kind === 'issued' ? t.code : 'XLM'))

describe('trustlines a position will need', () => {
  it('asks for cash on an XLM book, and nothing else', () => {
    // The premium arrives in cash; the escrow comes back as native XLM, which
    // every account can already hold.
    expect(codes(XLM)).toEqual([LUSD_CODE])
  })

  it('asks for the underlying too when it is issued', () => {
    // A call's escrow returns here, and an assigned put delivers the asset the
    // vault just bought. Both are paid by `settle`, long after the press.
    //
    // Spelled out rather than read from the environment: what is asserted is
    // the rule, not whichever issuer this machine happens to have configured.
    const issuedBook = {
      ...BTC,
      stellarAsset: { kind: 'issued', code: 'LBTC', issuer: ISSUER },
    } as UnderlyingAsset
    expect(codes(issuedBook)).toEqual([LUSD_CODE, 'LBTC'])
  })

  it('leaves out an underlying that names no issuer', () => {
    // Declared but not configured. The registry gates it; this makes sure the
    // wallet is never asked to trust it in the meantime.
    const halfConfigured = {
      ...BTC,
      stellarAsset: { kind: 'issued', code: 'LBTC', issuer: null },
    } as UnderlyingAsset
    expect(codes(halfConfigured)).toEqual([LUSD_CODE])
  })

  it('does not invent a classic asset for native XLM', () => {
    // The guard that keeps a changeTrust operation from being built for
    // something that cannot be trusted.
    expect(classicAsset({ kind: 'native' })).toBeNull()
  })

  it('refuses an issued asset with no issuer', () => {
    // A half-configured registry entry. The registry already gates these, and
    // this is the second wall: no issuer, no trustline, rather than a
    // changeTrust to the empty string.
    expect(classicAsset({ kind: 'issued', code: 'BTC', issuer: null })).toBeNull()
  })
})
