import { describe, it, expect, afterEach, vi } from 'vitest'
import { fetchLadder, fetchStrikeQuote } from '../quote-client'
import { cosignWithQuoter } from '../quoter'
import { recordDeposit } from '../deposit-client'

// What the browser puts on the wire.
// =================================
// Every endpoint the earn screen calls reads an absent `asset` as XLM, because
// silence is what Tranche 1's only client meant. That makes the omission
// dangerous rather than untidy: a page opened at /earn/btc that does not name
// its underlying is served XLM's spot, priced off XLM's volatility, co-signed
// against XLM's quote and written to XLM's vault — all of it consistent, all of
// it the wrong book, and nothing on screen saying so.
//
// So these tests are about one thing: the request carries the asset.

/** Record every request, and answer each endpoint with the least it accepts. */
function stubApi() {
  const calls: { url: string; body: any }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init?: any) => {
      const url = String(input)
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined })
      if (url.includes('/api/vault/quote')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            spot: 1,
            days: 7,
            utilization: 0.1,
            strikes: [{ index: 0, strike: 1, label: '1', apr: 0.1, userPremium: 0.01 }],
            quote: { strike: 1, daysToExpiry: 7, apr: 0.1, userPremium: 0.01 },
          }),
        } as any
      }
      if (url.includes('/api/vault/authorize')) {
        return { ok: true, json: async () => ({ authEntries: ['AAAA'] }) } as any
      }
      return { ok: true, json: async () => ({ ok: true }) } as any
    }),
  )
  return calls
}

const EXPIRY = '2026-12-25T16:00:00.000Z'
const assetOf = (url: string) =>
  new URL(url, 'https://vault.test').searchParams.get('asset')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the browser names the underlying', () => {
  it('asks for the ladder of the asset it was opened for', async () => {
    const calls = stubApi()
    await fetchLadder('call', EXPIRY, 'BTC')
    expect(assetOf(calls[0].url)).toBe('BTC')
  })

  it('reprices the strike against the same asset', async () => {
    const calls = stubApi()
    await fetchStrikeQuote('call', EXPIRY, 1, 'BTC')
    expect(assetOf(calls[0].url)).toBe('BTC')
  })

  it('asks the quoter to co-sign for that asset', async () => {
    const calls = stubApi()
    await cosignWithQuoter({
      address: 'GA'.padEnd(56, 'A'),
      side: 'call',
      asset: 'BTC',
      collateralAmount: 1,
      strikePrice: 1,
      expiryIso: EXPIRY,
      premium: 0.01,
      authEntries: ['AAAA'],
    })
    expect(calls[0].body.asset).toBe('BTC')
  })

  // The one the plan names explicitly: the record is what the portfolio, the
  // leaderboard and the settlement sweep read back, and an id is only unique
  // within an instance. A row filed under the wrong asset is position #3 in
  // somebody else's book.
  it('records the deposit in the book it was written to', async () => {
    const calls = stubApi()
    await recordDeposit({
      address: 'GA'.padEnd(56, 'A'),
      txHash: 'abc',
      positionId: 3,
      type: 'call',
      asset: 'BTC',
      collateralAmount: 1,
      strikePrice: 1,
      daysToExpiry: 7,
      expiryIso: EXPIRY,
    })
    expect(calls[0].body.asset).toBe('BTC')
  })

  // XLM is not the default here, it is a choice — so it travels too. Otherwise
  // "no asset on the wire" stays a valid state and the next caller inherits it.
  it('names XLM as explicitly as it names BTC', async () => {
    const calls = stubApi()
    await fetchLadder('put', EXPIRY, 'XLM')
    expect(assetOf(calls[0].url)).toBe('XLM')
  })
})
