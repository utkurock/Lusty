import { describe, it, expect, vi } from 'vitest'

// The vault's public reads are limited per client. One shared key let a single
// caller spend the bucket and turn the panel off for every visitor; a key per
// named address let a caller mint a fresh allowance with each made-up address.

vi.mock('@/lib/vault-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/vault-state')>()),
  computeOpenBuckets: async () => [],
}))

vi.mock('@/lib/lusd', () => ({
  LUSD_CODE: 'LUSD',
  LUSD_ISSUER: 'GISSUER',
  LUSD_DISTRIBUTOR: 'GDISTRIBUTOR',
}))

vi.mock('@stellar/stellar-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stellar/stellar-sdk')>()),
  Horizon: {
    Server: class {
      loadAccount = async () => {
        throw new Error('offline')
      }
    },
  },
}))

vi.mock('@/lib/contract-events', () => ({ fetchVaultEvents: async () => [] }))
vi.mock('@/lib/db-queries', () => ({
  getRecentDeposits: async () => [],
  getPositionsForAddress: async () => [],
}))
vi.mock('@/lib/vault-contract', () => ({
  getPosition: async () => {
    throw new Error('unused')
  },
  getPositionIdsOf: async () => [],
  settlementPayout: () => null,
  getPositionsOf: async () => [],
  getExposure: async () => 0,
  getVaultLimits: async () => ({ maxExpiryCall: 0, maxExpiryPut: 0 }),
}))

/** A valid-looking Stellar address, different for each n. */
function address(n: number): string {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let tail = ''
  let x = n
  for (let i = 0; i < 55; i++) {
    tail += B32[x % 32]
    x = Math.floor(x / 32)
  }
  return 'G' + tail
}

async function call(path: string, ip: string): Promise<number> {
  const url = `http://localhost${path}`
  const req = new Request(url, { headers: { 'cf-connecting-ip': ip } })
  const route = path.startsWith('/api/vault/stats')
    ? await import('@/app/api/vault/stats/route')
    : path.startsWith('/api/vault/events')
      ? await import('@/app/api/vault/events/route')
      : await import('@/app/api/vault/portfolio/route')
  return (await route.GET(req)).status
}

describe('/api/vault/stats', () => {
  it('refuses the client that spent its allowance and serves the next one', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 31; i++) statuses.push(await call('/api/vault/stats?asset=XLM', '198.51.100.60'))
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true)
    expect(statuses[30]).toBe(429)
    expect(await call('/api/vault/stats?asset=XLM', '198.51.100.61')).toBe(200)
  })
})

describe('/api/vault/events', () => {
  it('limits the vault-wide feed per client, not once for everybody', async () => {
    for (let i = 0; i < 30; i++) await call('/api/vault/events', '198.51.100.70')
    expect(await call('/api/vault/events', '198.51.100.70')).toBe(429)
    expect(await call('/api/vault/events', '198.51.100.71')).toBe(200)
  })

  it('does not hand out a fresh allowance for each new address', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 31; i++) {
      statuses.push(await call(`/api/vault/events?address=${address(1000 + i)}`, '198.51.100.72'))
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true)
    expect(statuses[30]).toBe(429)
    // Another client asking about the same addresses is not held to it.
    expect(await call(`/api/vault/events?address=${address(1000)}`, '198.51.100.73')).toBe(200)
  })
})

describe('/api/vault/portfolio', () => {
  it('does not hand out a fresh allowance for each new address', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 21; i++) {
      statuses.push(await call(`/api/vault/portfolio?address=${address(2000 + i)}`, '198.51.100.80'))
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true)
    expect(statuses[20]).toBe(429)
  })

  it('cannot be spent on a stranger\'s address by somebody else', async () => {
    const victim = address(3000)
    for (let i = 0; i < 25; i++) await call(`/api/vault/portfolio?address=${victim}`, '198.51.100.81')
    expect(await call(`/api/vault/portfolio?address=${victim}`, '198.51.100.82')).toBe(200)
  })
})
