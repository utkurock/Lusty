import { describe, it, expect } from 'vitest'
import { Asset, Networks } from '@stellar/stellar-sdk'
import { lineFor, spendableOf } from '../../hooks/useBalance'
import { fillAmount } from '../utils'
import { LUSD_CODE, LUSD_ISSUER } from '../lusd'
import { USDC_CODE, USDC_ISSUER } from '../usdc'
import { XLM } from '../assets'
import type { StellarAsset } from '../assets'

const NATIVE: StellarAsset = { kind: 'native' }
const LUSD: StellarAsset = { kind: 'issued', code: 'LUSD', issuer: 'GISSUER' }

const BALANCES = [
  { balance: '250.0000000', asset_type: 'native' },
  { balance: '1000.0000000', asset_type: 'credit_alphanum4', asset_code: 'LUSD', asset_issuer: 'GISSUER' },
  { balance: '7.0000000', asset_type: 'credit_alphanum4', asset_code: 'LUSD', asset_issuer: 'GOTHER' },
]

describe('lineFor', () => {
  it('picks the native line', () => {
    expect(lineFor(BALANCES, NATIVE)?.balance).toBe('250.0000000')
  })

  it('matches an issued asset on code AND issuer', () => {
    expect(lineFor(BALANCES, LUSD)?.balance).toBe('1000.0000000')
  })

  it('does not accept the same code from another issuer', () => {
    const impostor: StellarAsset = { kind: 'issued', code: 'LUSD', issuer: 'GNOBODY' }
    expect(lineFor(BALANCES, impostor)).toBeNull()
  })

  it('reports a missing trustline rather than guessing', () => {
    const btc: StellarAsset = { kind: 'issued', code: 'BTC', issuer: 'GISSUER' }
    expect(lineFor(BALANCES, btc)).toBeNull()
  })

  it('refuses an issued asset with no issuer configured', () => {
    expect(lineFor(BALANCES, { kind: 'issued', code: 'BTC', issuer: null })).toBeNull()
  })
})

describe('spendableOf', () => {
  it('holds back the account reserve and a fee buffer on native XLM', () => {
    // 2 base entries + 3 subentries = 5 × 0.5 = 2.5 reserve, plus 1 fee buffer.
    expect(spendableOf(250, NATIVE, 3)).toBe(246.5)
  })

  it('never reports a negative spendable balance', () => {
    expect(spendableOf(1, NATIVE, 3)).toBe(0)
  })

  it('leaves an issued balance alone — its reserve is paid in XLM', () => {
    expect(spendableOf(1000, LUSD, 3)).toBe(1000)
  })
})

describe('fillAmount', () => {
  it('rounds down to the asset\'s displayed decimals', () => {
    // Half of a real spendable XLM balance, not a seven-decimal fragment.
    expect(fillAmount(9492.3231707, 0.5, 2)).toBe(4746.16)
  })

  it('never exceeds the ceiling it was given', () => {
    expect(fillAmount(9492.3231707, 1, 2)).toBeLessThanOrEqual(9492.3231707)
    expect(fillAmount(0.05123456, 1, 5)).toBeLessThanOrEqual(0.05123456)
  })

  it('keeps a small-denomination asset from rounding to nothing', () => {
    // A BTC book's whole allowance is a fraction of one unit.
    expect(fillAmount(0.05, 0.5, 5)).toBe(0.025)
  })
})

describe('stable identities', () => {
  // The classic line a balance is read from and the SAC the vault pulls have
  // to be the same asset. They are configured by different env vars, so a
  // half-applied change desyncs them silently — and the balance on screen then
  // describes an asset the contract will never touch.
  it('LUSD: the classic asset and the configured SAC agree', () => {
    const sac = new Asset(LUSD_CODE, LUSD_ISSUER).contractId(Networks.TESTNET)
    expect(sac).toBe(XLM.contracts.cash)
  })

  it('USDC: the classic asset derives the SAC the app is configured with', () => {
    const sac = new Asset(USDC_CODE, USDC_ISSUER).contractId(Networks.TESTNET)
    expect(sac).toBe(
      process.env.NEXT_PUBLIC_USDC_CONTRACT ??
        'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    )
  })

  it('LUSD and USDC are not the same asset', () => {
    expect(`${LUSD_CODE}:${LUSD_ISSUER}`).not.toBe(`${USDC_CODE}:${USDC_ISSUER}`)
  })
})
