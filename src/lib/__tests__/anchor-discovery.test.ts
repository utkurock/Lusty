import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * SEP-1 discovery is the load-bearing step of the anchor section: every other
 * call is made against an endpoint read out of this file. So what is tested
 * here is the reading — that a signboard yields the endpoints it advertises,
 * that a file missing the mandatory ones is rejected rather than half-used, and
 * that a failed read does not stick around as a cached failure.
 */

const TOML = `VERSION="2.7.0"
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
SIGNING_KEY="GDXYO6FJCNXZEWGXD54GT76FGFYLOLSOGSOJLNQ6WGHCGEQPO7NTE73M"
WEB_AUTH_ENDPOINT="https://anchor.example/auth"
TRANSFER_SERVER="https://anchor.example/sep6/"
KYC_SERVER="https://anchor.example/sep12"
ANCHOR_QUOTE_SERVER="https://anchor.example/sep38"
ACCOUNTS=["GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6", "GDXYO6FJCNXZEWGXD54GT76FGFYLOLSOGSOJLNQ6WGHCGEQPO7NTE73M"]

[DOCUMENTATION]
ORG_NAME="TR Mock Anchor (testnet sandbox)"
# a comment, and a blank line, both ignored

[[CURRENCIES]]
code="USDC"
issuer="GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
display_decimals=2
desc="USDC on Stellar testnet."

[[CURRENCIES]]
code="EURC"
issuer="GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO"
display_decimals=2
`

function serve(body: string, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 404,
    text: async () => body,
  })
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('anchor discovery', () => {
  it('reads the endpoints, accounts and currencies off the signboard', async () => {
    vi.stubGlobal('fetch', serve(TOML))
    const { loadAnchorToml } = await import('@/lib/anchor/client')

    const toml = await loadAnchorToml('anchor.example')

    expect(toml.webAuthEndpoint).toBe('https://anchor.example/auth')
    expect(toml.kycServer).toBe('https://anchor.example/sep12')
    expect(toml.quoteServer).toBe('https://anchor.example/sep38')
    expect(toml.signingKey).toMatch(/^GDXYO/)
    expect(toml.orgName).toBe('TR Mock Anchor (testnet sandbox)')
    expect(toml.accounts).toHaveLength(2)
    expect(toml.currencies.map(c => c.code)).toEqual(['USDC', 'EURC'])
    expect(toml.currencies[0].issuer).toMatch(/^GBBD47IF/)
  })

  /* Endpoints are concatenated with a path everywhere they are used, so a
     trailing slash on the signboard would produce //deposit on every call. */
  it('normalises a transfer server that ends in a slash', async () => {
    vi.stubGlobal('fetch', serve(TOML))
    const { loadAnchorToml } = await import('@/lib/anchor/client')

    expect((await loadAnchorToml('anchor.example')).transferServer).toBe(
      'https://anchor.example/sep6'
    )
  })

  it('names the asset the way SEP-38 does', async () => {
    vi.stubGlobal('fetch', serve(TOML))
    const { anchorCurrency, sep38Asset } = await import('@/lib/anchor/client')

    const usdc = await anchorCurrency('USDC')
    expect(sep38Asset(usdc)).toBe(
      'stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    )
  })

  it('refuses an asset the anchor does not list', async () => {
    vi.stubGlobal('fetch', serve(TOML))
    const { anchorCurrency } = await import('@/lib/anchor/client')

    await expect(anchorCurrency('TRYC')).rejects.toThrow(/not listed/)
  })

  /* Without a transfer server there is no ramp at all, and a partially read
     signboard would fail later, at a call site with no idea why. */
  it('rejects a signboard with no SEP-6 server', async () => {
    vi.stubGlobal('fetch', serve('WEB_AUTH_ENDPOINT="https://anchor.example/auth"'))
    const { loadAnchorToml } = await import('@/lib/anchor/client')

    await expect(loadAnchorToml('anchor.example')).rejects.toThrow(/SEP-10 or SEP-6/)
  })

  /* The result is memoised. A failure must not be: a page that happened to
     load while the anchor was down would never recover without a reload. */
  it('does not cache a failed read', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', failing)
    const { loadAnchorToml } = await import('@/lib/anchor/client')

    await expect(loadAnchorToml('anchor.example')).rejects.toThrow(/could not be reached/)

    vi.stubGlobal('fetch', serve(TOML))
    const toml = await loadAnchorToml('anchor.example')
    expect(toml.transferServer).toBe('https://anchor.example/sep6')
  })
})

describe('anchor asset labels', () => {
  it('reads the code out of either side of a SEP-38 pair', async () => {
    const { assetLabel } = await import('@/lib/anchor/sep6')

    expect(assetLabel('iso4217:TRY')).toBe('TRY')
    expect(assetLabel('stellar:USDC:GBBD47IF')).toBe('USDC')
    expect(assetLabel(null)).toBe('')
  })
})
