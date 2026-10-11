import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import { fakeDb, fakeHorizon } from './payout-fakes'

// What the swap pays, and what it will not pay at all.
// ====================================================
// Three findings meet in one route. The payout used to be priced at claim
// time with a cap the caller chose, which made the fifteen minutes a payment
// may wait a free option on the price. lusd_to_xlm turned faucet LUSD into the
// distributor's XLM with no bound on net flow and no look at what the account
// needs to keep signing. And the fee was a cut of the uncapped gross. Each is
// driven here through the real route, proof, flow ledger and SDK.

const DISTRIBUTOR = Keypair.random()
const ISSUER = Keypair.random().publicKey()
const PAYER = Keypair.random().publicKey()
const OTHER = Keypair.random().publicKey()
const FEE = Keypair.random().publicKey()

process.env.LUSD_DISTRIBUTOR_SECRET = DISTRIBUTOR.secret()
process.env.NEXT_PUBLIC_LUSD_DISTRIBUTOR = DISTRIBUTOR.publicKey()
process.env.NEXT_PUBLIC_LUSD_ISSUER = ISSUER
process.env.FEE_WALLET = FEE
process.env.SWAP_XLM_OUT_DAILY_MAX = '1000'
delete process.env.SWAP_DISTRIBUTOR_XLM_FLOOR

const db = fakeDb()
const horizon = fakeHorizon()
vi.stubGlobal('fetch', horizon.fetch)

const prices = { live: 0.1, atFunding: null as number | null }
const durableRateLimit = vi.fn(async (..._a: any[]) => ({ ok: true }) as const)

vi.mock('@/lib/db', () => ({ ensureSchema: async () => {}, getPool: () => db.pool }))
vi.mock('@/lib/db-queries', () => ({ logTransaction: vi.fn(async () => {}) }))
vi.mock('@/lib/rate-limit', () => ({ durableRateLimit: (...a: any[]) => durableRateLimit(...a) }))
vi.mock('@/lib/spot', () => ({ fetchXlmUsd: async () => prices.live }))
vi.mock('@/lib/reflector', () => ({ reflectorPriceAt: async () => prices.atFunding }))

const swap = await import('@/app/api/swap/route')
const bridge = await import('@/app/api/anchor/bridge/route')
const { distributorMismatch } = await import('@/lib/swap-proof')

const lusdLine = (balance = '100000') => ({
  asset_type: 'credit_alphanum4',
  asset_code: 'LUSD',
  asset_issuer: ISSUER,
  balance,
})

let n = 0
/** A successful funding payment from PAYER to the distributor; returns its hash. */
function fund(asset: 'XLM' | 'LUSD', amount: number, ageMs = 10 * 60_000): string {
  const hash = (++n).toString(16).padStart(64, '0')
  horizon.txs.set(hash, {
    tx: {
      hash,
      successful: true,
      source_account: PAYER,
      created_at: new Date(Date.now() - ageMs).toISOString(),
    },
    operations: [
      {
        type: 'payment',
        to: DISTRIBUTOR.publicKey(),
        amount: amount.toFixed(7),
        transaction_successful: true,
        ...(asset === 'XLM'
          ? { asset_type: 'native' }
          : { asset_type: 'credit_alphanum4', asset_code: 'LUSD', asset_issuer: ISSUER }),
      },
    ],
  })
  return hash
}

function distributorHolds(nativeBalance: string, subentries = 3) {
  horizon.accounts.set(DISTRIBUTOR.publicKey(), {
    id: DISTRIBUTOR.publicKey(),
    subentry_count: subentries,
    balances: [lusdLine(), { asset_type: 'native', balance: nativeBalance, selling_liabilities: '0' }],
  })
}

/** Earlier swaps on the ledger: XLM this address has put in or taken out. */
function flow(address: string, xlmIn: number, xlmOut: number) {
  db.flows.push({
    hash: `seed-${++n}`,
    address,
    direction: xlmIn > 0 ? 'xlm_to_lusd' : 'lusd_to_xlm',
    xlm_in: xlmIn,
    xlm_out: xlmOut,
    status: 'settled',
    created_at: Date.now() - 60_000,
  })
}

beforeEach(() => {
  db.reset()
  horizon.reset()
  durableRateLimit.mockClear()
  prices.live = 0.1
  prices.atFunding = null
  horizon.accounts.set(PAYER, { id: PAYER, balances: [lusdLine('1000'), { asset_type: 'native', balance: '1000' }] })
  horizon.accounts.set(FEE, { id: FEE, balances: [lusdLine('0')] })
  distributorHolds('100000')
})

const claim = (txHash: string, direction: 'xlm_to_lusd' | 'lusd_to_xlm', sourceAmount: number, expectedDestAmount = 1e15) =>
  swap.POST(
    new Request('http://t/api/swap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: PAYER, txHash, direction, sourceAmount, expectedDestAmount }),
    }),
  )

/** The distributor's payment to the caller, and its fee payment, if any. */
const paid = () => {
  const ops = horizon.submitted.at(-1)!.operations as any[]
  return { payout: ops[0], fee: ops[1] }
}

describe('the price a swap pays at', () => {
  it('does not pay a price that rose after funding (xlm_to_lusd, caller cap removed)', async () => {
    prices.atFunding = 0.1
    prices.live = 0.12
    const res = await claim(fund('XLM', 500), 'xlm_to_lusd', 500)
    expect(res.status).toBe(200)
    expect(paid().payout.amount).toBe('49.9500000')
  })

  it('does not pay a price that fell after funding (lusd_to_xlm, caller cap removed)', async () => {
    flow(PAYER, 1000, 0)
    prices.atFunding = 0.1
    prices.live = 0.08
    const res = await claim(fund('LUSD', 50), 'lusd_to_xlm', 50)
    expect(res.status).toBe(200)
    expect(paid().payout.amount).toBe('499.5000000')
    expect(paid().payout.asset.isNative()).toBe(true)
  })

  it('pays the live price when it is the worse one', async () => {
    prices.atFunding = 0.12
    prices.live = 0.1
    await claim(fund('XLM', 500), 'xlm_to_lusd', 500)
    expect(paid().payout.amount).toBe('49.9500000')
  })

  it('falls back to the live price when the funding period has no record yet', async () => {
    prices.atFunding = null
    prices.live = 0.1
    const res = await claim(fund('XLM', 500, 5_000), 'xlm_to_lusd', 500)
    expect(res.status).toBe(200)
    expect(paid().payout.amount).toBe('49.9500000')
  })

  it('still caps at what the caller was shown', async () => {
    await claim(fund('XLM', 500), 'xlm_to_lusd', 500, 49)
    expect(paid().payout.amount).toBe('49.0000000')
  })

  it('takes the fee on what was paid, not on the uncapped gross', async () => {
    await claim(fund('XLM', 500), 'xlm_to_lusd', 500, 40)
    expect(paid().payout.amount).toBe('40.0000000')
    expect(paid().fee.destination).toBe(FEE)
    // 40 is the net of a 40.04004 gross; the fee is that gross's spread.
    expect(paid().fee.amount).toBe((40 * 0.001 / 0.999).toFixed(7))
  })
})

describe('XLM out is bounded by XLM in', () => {
  it('refuses lusd_to_xlm from an address that never swapped XLM in', async () => {
    const res = await claim(fund('LUSD', 50), 'lusd_to_xlm', 50)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('no_xlm_credit')
    expect(horizon.payouts()).toBe(0)
    expect(db.actions).toEqual([])
    expect(db.flows).toEqual([])
  })

  it('lets an address take back what it put in, and no more', async () => {
    expect((await claim(fund('XLM', 500), 'xlm_to_lusd', 500)).status).toBe(200)
    expect((await claim(fund('LUSD', 30), 'lusd_to_xlm', 30)).status).toBe(200) // 299.7 XLM
    const third = await claim(fund('LUSD', 30), 'lusd_to_xlm', 30) // another 299.7 > 200.3 left
    expect(third.status).toBe(409)
    expect((await third.json()).code).toBe('no_xlm_credit')
    expect(horizon.payouts()).toBe(2)
  })

  it('does not lend one address another s credit', async () => {
    flow(OTHER, 10_000, 0)
    const res = await claim(fund('LUSD', 50), 'lusd_to_xlm', 50)
    expect(res.status).toBe(409)
  })

  it('stops everyone together at the daily XLM ceiling', async () => {
    flow(PAYER, 5_000, 0)
    flow(OTHER, 0, 900)
    const res = await claim(fund('LUSD', 50), 'lusd_to_xlm', 50) // 499.5 > 100 left today
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('xlm_daily_cap')
    expect(horizon.payouts()).toBe(0)
  })

  it('answers a replayed reverse swap as already processed, not as out of credit', async () => {
    flow(PAYER, 500, 0)
    const h = fund('LUSD', 50)
    expect((await claim(h, 'lusd_to_xlm', 50)).status).toBe(200) // 499.5 of 500
    const again = await claim(h, 'lusd_to_xlm', 50)
    expect(again.status).toBe(409)
    expect((await again.json()).code).toBe('already_processed')
    expect(horizon.payouts()).toBe(1)
  })

  it('reserves the flow before signing, and settles it once the payout lands', async () => {
    flow(PAYER, 1000, 0)
    const h = fund('LUSD', 50)
    await claim(h, 'lusd_to_xlm', 50)
    expect(db.flows.find((f) => f.hash === h)).toMatchObject({ status: 'settled', xlm_out: 499.5 })
  })

  it('gives the room back when the network refused the payout', async () => {
    flow(PAYER, 1000, 0)
    horizon.answerSubmitWith(() =>
      horizon.json(400, { extras: { result_codes: { transaction: 'tx_bad_seq' } } }),
    )
    const h = fund('LUSD', 50)
    expect((await claim(h, 'lusd_to_xlm', 50)).status).toBe(500)
    expect(db.flows.find((f) => f.hash === h)).toBeUndefined()
    expect(db.actions).toEqual([])
  })

  it('keeps the room taken when nobody knows whether the payout landed', async () => {
    flow(PAYER, 1000, 0)
    horizon.answerSubmitWith(() => horizon.json(504, { title: 'Timeout' }))
    const h = fund('LUSD', 50)
    expect((await claim(h, 'lusd_to_xlm', 50)).status).toBe(502)
    expect(db.flows.find((f) => f.hash === h)).toMatchObject({ status: 'pending', xlm_out: 499.5 })
  })
})

describe('the distributor keeps enough XLM to sign', () => {
  it('refuses a native payout that would take it under the floor', async () => {
    flow(PAYER, 1000, 0)
    // 300 held, 2.5 locked by the reserve: 297.5 spendable, less 499.5 is short.
    distributorHolds('300')
    const res = await claim(fund('LUSD', 50), 'lusd_to_xlm', 50)
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('distributor_low')
    expect(horizon.payouts()).toBe(0)
    expect(db.flows.filter((f) => f.status === 'pending')).toEqual([])
    expect(db.actions).toEqual([])
  })

  it('counts the reserve and the floor, not just the balance', async () => {
    flow(PAYER, 1000, 0)
    // 520 held covers 499.5, but not with 2.5 reserved and 25 kept back.
    distributorHolds('520')
    expect((await claim(fund('LUSD', 50), 'lusd_to_xlm', 50)).status).toBe(503)
    distributorHolds('530')
    expect((await claim(fund('LUSD', 50), 'lusd_to_xlm', 50)).status).toBe(200)
  })
})

describe('the preflights', () => {
  const preflight = (url: string, handler: (r: Request) => Promise<Response>) =>
    handler(new Request(url, { headers: { 'cf-connecting-ip': '203.0.113.7' } }))

  it('bounds the swap preflight per client', async () => {
    await preflight('http://t/api/swap?direction=xlm_to_lusd&amount=10', swap.GET)
    expect(durableRateLimit).toHaveBeenCalledWith('swap-preflight:ip:203.0.113.7', 60_000, 30)

    durableRateLimit.mockResolvedValueOnce({ ok: false, retryAfter: 9 } as any)
    const res = await preflight('http://t/api/swap?direction=xlm_to_lusd&amount=10', swap.GET)
    expect(res.status).toBe(429)
  })

  it('bounds the bridge preflight per client', async () => {
    await preflight('http://t/api/anchor/bridge?direction=anchor_to_cash&amount=10', bridge.GET)
    expect(durableRateLimit).toHaveBeenCalledWith('anchor-bridge-preflight:ip:203.0.113.7', 60_000, 30)
  })

  it('says before the payment that an address has no XLM to take back', async () => {
    const res = await preflight(
      `http://t/api/swap?direction=lusd_to_xlm&amount=50&address=${PAYER}`,
      swap.GET,
    )
    const body = await res.json()
    expect(body.ready).toBe(false)
    expect(body.code).toBe('no_xlm_credit')
  })

  it('applies the same native floor as the payout', async () => {
    flow(PAYER, 1000, 0)
    distributorHolds('520')
    const res = await preflight(
      `http://t/api/swap?direction=lusd_to_xlm&amount=50&address=${PAYER}`,
      swap.GET,
    )
    expect((await res.json()).ready).toBe(false)
  })
})

describe('the request itself', () => {
  it('refuses a body past the cap before anything is looked up', async () => {
    const res = await swap.POST(
      new Request('http://t/api/swap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pad: 'x'.repeat(70_000) }),
      }),
    )
    expect(res.status).toBe(413)
    expect(horizon.paths).toEqual([])
  })

  it('refuses a distributor secret that is not the advertised distributor', () => {
    expect(distributorMismatch(DISTRIBUTOR.secret())).toBeNull()
    expect(distributorMismatch(Keypair.random().secret())).toMatch(/does not belong/)
    expect(distributorMismatch('not a secret')).toMatch(/not a valid/)
  })
})
