import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DECLARATIONS } from '../assets/config'
import { declare } from '../assets/schema'
import { allUnderlyings, resolveUnderlying, settleableUnderlying } from '../assets'
import { quoteOption } from '../pricing-server'
import { strikeRungs, roundStrike } from '../pricing'
import { upcomingExpiryDates, maxOpenExpiryDays } from '../expiries'
import { callEpochCap, putEpochCap, epochsPerMonth } from '../vault-state'

// M2-07: an asset is added by configuration, and this is the receipt.
// ===================================================================
// ETH is declared in config.ts and nowhere else. Under M1's registry that was
// impossible — `UnderlyingSymbol` was a closed union, so listing an asset meant
// editing a type first — and the point of the commit is that it now costs one
// entry. What these assert is the two halves of that claim: that the framework
// accepts the declaration whole, and that the parts which cannot be satisfied
// by configuration alone are named rather than guessed at.

const ETH = DECLARATIONS.find((d) => d.symbol === 'ETH')!

describe('the third book arrives as configuration', () => {
  it('is declared, and is the only place ETH is written', () => {
    expect(ETH).toBeDefined()
    expect(allUnderlyings().map((a) => a.symbol)).toContain('ETH')
  })

  it('ships gated on the two values a deployment has to supply', () => {
    const eth = declare(ETH, {})
    expect(eth.enabled).toBe(false)
    // Unconfigured, not invalid. The difference is who fixes it: nobody has
    // deployed the instance yet, which is a plan, not a bug that shipped.
    expect(eth.issues.every((i) => i.kind === 'unconfigured')).toBe(true)
    expect(eth.issues.map((i) => i.field).sort()).toEqual([
      'contracts.token',
      'contracts.vault',
      'stellarAsset.issuer',
    ])
  })

  it('leaves the books that are live exactly where they were', () => {
    // The failure this guards is the one a third declaration could plausibly
    // cause: a shared constant edited to fit ETH, or a symbol collision taking
    // another book down with it.
    expect(resolveUnderlying('XLM')?.enabled).toBe(true)
    expect(resolveUnderlying('ETH')).toBeNull()
    // BTC is gated in the runner, which supplies XLM's contract and no other —
    // so what matters is that every reason it is gated is still one of its own
    // fields. A third declaration reaching into another book's is the failure.
    const btc = allUnderlyings().find((a) => a.symbol === 'BTC')!
    for (const issue of btc.issues) {
      expect(issue.field).toMatch(/^(contracts|stellarAsset)\./)
    }
  })

  it('has nothing to settle, because it has no instance', () => {
    // A gated book still settles — collateral has to come back whether or not
    // the book is being written. ETH is the other case: there is no instance,
    // so there is nothing of anyone's in it.
    expect(settleableUnderlying('ETH')).toBeNull()
  })

  it('would be enabled by the environment alone', () => {
    // The whole claim, run: supply the three missing values and nothing else,
    // and the book is live. No code path is added by this test either.
    const eth = declare(ETH, {
      NEXT_PUBLIC_VAULT_CONTRACT_ETH:
        'CBQEACXAOZMCU3YOUWDC3MWXDSQBWKNGKBA6XMRPY5D5JQRNP2HLMVEU',
      NEXT_PUBLIC_ETH_CONTRACT:
        'CDLI2GIDMYZQHK2K3TIGV5O2HQQRT36C5MV3IQWO6LX22YFTF43X74LU',
      NEXT_PUBLIC_ETH_ANCHOR_ISSUER:
        'GB6274FEMTPWDEZ47P2YCXQ6JZCPRTHB5NMSFVPIUFB6MK5RXNBWZ2E2',
    })
    expect(eth.issues).toEqual([])
    expect(eth.enabled).toBe(true)
  })
})

describe('every rail reads the declaration without being taught ETH', () => {
  const eth = declare(ETH, {})
  const spot = 4_000

  it('prices a ladder off its own declared rungs', () => {
    const rungs = strikeRungs('call', eth.strike)
    const aprs = rungs.map(
      (m) =>
        quoteOption({
          side: 'call',
          spot,
          strike: roundStrike(spot * m, spot, eth.strike.tickFraction),
          daysToExpiry: 7,
          sigmaRealized: 0.7,
          strikes: eth.strike,
          expiries: eth.expiry,
        }).apr,
    )
    expect(aprs).toHaveLength(rungs.length)
    for (let i = 1; i < aprs.length; i++) expect(aprs[i]).toBeLessThan(aprs[i - 1])
  })

  it('schedules its own expiries', () => {
    const from = new Date('2026-06-08T12:00:00Z')
    expect(upcomingExpiryDates(from, eth.expiry)).toHaveLength(eth.expiry.openExpiries)
    expect(maxOpenExpiryDays(from, eth.expiry)).toBeGreaterThanOrEqual(
      eth.expiry.minDaysToExpiry,
    )
  })

  it('divides its own capacity by its own count', () => {
    expect(epochsPerMonth(eth)).toBe(eth.expiry.openExpiries)
    expect(callEpochCap(eth)).toBeCloseTo(eth.callMonthlyCap / eth.expiry.openExpiries, 10)
    expect(putEpochCap(eth)).toBeCloseTo(
      eth.putMonthlyCapUsd / eth.expiry.openExpiries,
      10,
    )
  })
})

describe('what configuration alone cannot supply', () => {
  it('every declared mark is a file that exists', () => {
    // The one field the load-time validator cannot check: it runs in the
    // browser too, where there is no filesystem, so it can only ask whether the
    // logo is a path. A path to nothing passes validation and renders a broken
    // image, which is the kind of thing found by whoever enables the book.
    for (const d of DECLARATIONS) {
      const file = join(process.cwd(), 'public', d.logo.replace(/^\//, ''))
      expect(existsSync(file), `${d.symbol} declares ${d.logo}, which is missing`).toBe(
        true,
      )
    }
  })
})
