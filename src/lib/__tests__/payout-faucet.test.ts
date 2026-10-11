import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import { fakeHorizon } from './payout-fakes'

// One client cannot spend everybody's faucet.
// ===========================================
// The daily cap is shared across every address, which is what makes it
// survive address farming — and also what let one client, farming fresh
// addresses, spend the whole day and close the faucet for everyone else. The
// per-client bound sits behind the address checks and in front of the payout.
// Driven through the real route, caps and rate limiter (in its per-process
// form, since there is no database here), against a fake Horizon.

const DISTRIBUTOR = Keypair.random()
const ISSUER = Keypair.random().publicKey()

process.env.LUSD_DISTRIBUTOR_SECRET = DISTRIBUTOR.secret()
process.env.NEXT_PUBLIC_LUSD_DISTRIBUTOR = DISTRIBUTOR.publicKey()
process.env.NEXT_PUBLIC_LUSD_ISSUER = ISSUER
process.env.FAUCET_CLIENT_DAILY_CLAIMS = '3'
delete process.env.DATABASE_URL

const horizon = fakeHorizon()
vi.stubGlobal('fetch', horizon.fetch)

// Nobody has claimed anything: no cooldown, no lifetime or daily total.
const query = vi.fn(async (sql: string): Promise<{ rows: any[] }> =>
  sql.includes('max(created_at)') ? { rows: [{ at: null }] } : { rows: [{ s: 0 }] },
)
vi.mock('@/lib/db', () => ({ ensureSchema: async () => {}, getPool: () => ({ query }) }))
vi.mock('@/lib/db-queries', () => ({ logTransaction: vi.fn(async () => {}) }))

const { POST } = await import('@/app/api/faucet/[asset]/route')

const lusd = { asset_type: 'credit_alphanum4', asset_code: 'LUSD', asset_issuer: ISSUER, balance: '0' }

function newTester(): string {
  const id = Keypair.random().publicKey()
  horizon.accounts.set(id, { id, balances: [lusd, { asset_type: 'native', balance: '100' }] })
  return id
}

beforeEach(() => {
  horizon.reset()
  horizon.accounts.set(DISTRIBUTOR.publicKey(), {
    id: DISTRIBUTOR.publicKey(),
    balances: [{ ...lusd, balance: '1000000' }, { asset_type: 'native', balance: '10000' }],
  })
})

const drip = (address: string, ip: string, init: RequestInit = {}) =>
  POST(
    new Request('http://t/api/faucet/lusd', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify({ address }),
      ...init,
    }),
    { params: Promise.resolve({ asset: 'lusd' }) },
  )

describe('the faucet per client', () => {
  it('stops one client farming fresh addresses at its own share of the day', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) statuses.push((await drip(newTester(), '198.51.100.1')).status)

    expect(statuses).toEqual([200, 200, 200, 429, 429])
    expect(horizon.payouts()).toBe(3)
  })

  it('says why, and when to come back', async () => {
    for (let i = 0; i < 3; i++) await drip(newTester(), '198.51.100.2')
    const body = await (await drip(newTester(), '198.51.100.2')).json()
    expect(body.code).toBe('client_cap')
    expect(body.retryAfter).toBeGreaterThan(0)
  })

  it('leaves every other client its own allowance', async () => {
    for (let i = 0; i < 4; i++) await drip(newTester(), '198.51.100.3')
    expect((await drip(newTester(), '198.51.100.4')).status).toBe(200)
  })

  it('does not spend the allowance on a claim the address checks refused', async () => {
    query.mockImplementation(async (sql: string) =>
      sql.includes('max(created_at)') ? { rows: [{ at: new Date() }] } : { rows: [{ s: 0 }] },
    )
    for (let i = 0; i < 5; i++) {
      const body = await (await drip(newTester(), '198.51.100.5')).json()
      expect(body.code).toBe('cooldown')
    }
    query.mockImplementation(async (sql: string) =>
      sql.includes('max(created_at)') ? { rows: [{ at: null }] } : { rows: [{ s: 0 }] },
    )
    expect((await drip(newTester(), '198.51.100.5')).status).toBe(200)
  })
})

describe('the faucet request', () => {
  it('refuses a body that is not declared JSON', async () => {
    const res = await drip(newTester(), '198.51.100.6', {
      headers: { 'content-type': 'text/plain', 'cf-connecting-ip': '198.51.100.6' },
    })
    expect(res.status).toBe(415)
    expect(horizon.payouts()).toBe(0)
  })

  it('refuses a body past the cap', async () => {
    const res = await drip(newTester(), '198.51.100.7', {
      body: JSON.stringify({ address: newTester(), pad: 'x'.repeat(70_000) }),
    })
    expect(res.status).toBe(413)
    expect(horizon.payouts()).toBe(0)
  })

  it('treats a body that is not JSON as no address', async () => {
    const res = await drip(newTester(), '198.51.100.8', { body: '{not json' })
    expect(res.status).toBe(400)
  })
})
