import { describe, it, expect, vi, beforeEach } from 'vitest'

// Lapsed reservations, settled for every wallet — not only the one asking.
//
// A reservation names whatever address its request did, and the per-strike
// inventory is shared. Settled only when that same address came back to
// authorize, three throwaway addresses could hold a strike closed to everyone
// for the whole 14-day window. The monitor's sweep bounds that to one interval,
// with the same fail-closed rule: what cannot be checked keeps counting.

interface Row {
  id: number
  address: string
  underlying: string
  subtype: 'call' | 'put'
  collateral: number
  notional_usd: number
  strike_price: number
  expiry_iso: string
  signed_at: number
  valid_until: number
  state: 'pending' | 'opened' | 'indexed' | 'unused'
}

/** A row in `transactions`, as the deposit route writes one. */
interface Deposit {
  address: string
  underlying: string
  subtype: 'call' | 'put'
  amount: number
  metadata: { collateralAmount: number; strikePrice: number; expiryIso: string; spotAtOpen?: number }
}

const EXPIRY = '2026-10-16T08:00:00.000Z'
let rows: Row[] = []
let deposits: Deposit[] = []
let nextId = 1
const queries: { sql: string; params: any[] }[] = []
/** Replaces the fake store for a test that only needs canned rows. */
let canned: ((sql: string, params: any[]) => { rows: any[] }) | null = null

const add = (over: Partial<Row>) => {
  const now = Date.now()
  rows.push({
    id: nextId++,
    address: 'GA',
    underlying: 'XLM',
    subtype: 'call',
    collateral: 10_000,
    notional_usd: 2_500,
    strike_price: 0.3,
    expiry_iso: EXPIRY,
    signed_at: now - 20 * 60_000,
    valid_until: now - 10 * 60_000,
    state: 'pending',
    ...over,
  })
}

// Just enough of quote_reservations to run the policy's own queries against.
// Every branch is keyed on SQL the policy really sends, so a query that
// changes shape stops matching and the test fails rather than passing blind.
function answer(sql: string, params: any[]): { rows: any[] } {
  const now = Date.now()
  const lapsed = (r: Row) => r.state === 'pending' && r.valid_until < now
  if (sql.includes('group by address, underlying')) {
    const seen = new Map<string, { address: string; underlying: string; first: number }>()
    for (const r of rows.filter(lapsed)) {
      const k = `${r.address}|${r.underlying}`
      const cur = seen.get(k)
      if (!cur || r.valid_until < cur.first) seen.set(k, { address: r.address, underlying: r.underlying, first: r.valid_until })
    }
    return {
      rows: [...seen.values()].sort((a, b) => a.first - b.first).slice(0, params[0]),
    }
  }
  if (sql.includes("state = 'pending' and valid_until < now()") && sql.includes('address = $1')) {
    return {
      rows: rows
        .filter((r) => r.address === params[0] && r.underlying === params[1] && lapsed(r))
        .sort((a, b) => a.id - b.id),
    }
  }
  if (sql.includes("state in ('opened','indexed')")) {
    return {
      rows: rows.filter(
        (r) => r.address === params[0] && r.underlying === params[1] && (r.state === 'opened' || r.state === 'indexed'),
      ),
    }
  }
  if (sql.includes('from transactions') && sql.includes("jsonb_typeof(metadata->'spotAtOpen') = 'number'")) {
    return {
      rows: deposits
        .filter(
          (d) =>
            d.address === params[0] &&
            d.underlying === params[1] &&
            (d.subtype === 'put' || typeof d.metadata.spotAtOpen === 'number'),
        )
        .map((d) => ({
          subtype: d.subtype,
          collateral: d.metadata.collateralAmount,
          strike_price: d.metadata.strikePrice,
          expiry_iso: d.metadata.expiryIso,
        })),
    }
  }
  if (sql.includes('update quote_reservations') && sql.includes("then 'indexed'")) {
    const [opened, indexed, all] = params as [number[], number[], number[]]
    for (const r of rows) {
      if (all.includes(r.id) && r.state === 'pending')
        r.state = opened.includes(r.id) ? 'opened' : indexed.includes(r.id) ? 'indexed' : 'unused'
    }
    return { rows: [] }
  }
  if (sql.includes("(t.metadata->>'strikePrice')::float8 between")) {
    const [lo, hi, underlying] = params
    const usd = (d: Deposit) =>
      d.subtype === 'put' ? d.amount : d.metadata.spotAtOpen != null ? d.amount * d.metadata.spotAtOpen : 0
    return {
      rows: [
        {
          sum: deposits
            .filter((d) => d.underlying === underlying && d.metadata.strikePrice >= lo && d.metadata.strikePrice <= hi)
            .reduce((a, d) => a + usd(d), 0),
        },
      ],
    }
  }
  if (sql.includes('as strike_notional')) {
    const [address, underlying, dateKey, lo, hi] = params
    const live = rows.filter((r) => r.underlying === underlying && (r.state === 'pending' || r.state === 'opened'))
    const sum = (rs: Row[], f: (r: Row) => number) => rs.reduce((a, r) => a + f(r), 0)
    return {
      rows: [
        {
          user_notional: sum(live.filter((r) => r.address === address), (r) => r.notional_usd),
          epoch_call: sum(
            live.filter((r) => r.address === address && r.subtype === 'call' && r.expiry_iso.slice(0, 10) === dateKey),
            (r) => r.collateral,
          ),
          epoch_put: 0,
          strike_notional: sum(
            live.filter((r) => r.strike_price >= lo && r.strike_price <= hi),
            (r) => r.notional_usd,
          ),
        },
      ],
    }
  }
  return { rows: [{ sum: 0 }] }
}

vi.mock('../db', async (importOriginal) => ({
  COLLATERAL_USD_SQL: (await importOriginal<typeof import('../db')>()).COLLATERAL_USD_SQL,
  ensureSchema: async () => {},
  getPool: () => ({
    query: async (sql: string, params: any[] = []) => {
      queries.push({ sql, params })
      return (canned ?? answer)(sql, params)
    },
  }),
}))

import {
  assertQuoteAllowed,
  sweepLapsedReservations,
  reservedOpenPrice,
  type PolicyInput,
  type OnChainPosition,
} from '../quote-policy'

const policy = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  address: 'GVICTIM',
  underlying: 'XLM',
  type: 'call',
  collateralAmount: 10_000,
  notionalUsd: 2_500,
  strikePrice: 0.3,
  strikeBucketPct: 0.01,
  expiryIso: EXPIRY,
  maxUserNotionalUsd: 50_000,
  strikeInventoryLimitUsd: 10_000,
  maxUserEpochCallXlm: 100_000,
  maxUserEpochPutUsd: 100_000,
  ...over,
})

const position = (over: Partial<OnChainPosition> = {}): OnChainPosition => ({
  side: 'call',
  collateral: 10_000,
  strike: 0.3,
  expiry: new Date(EXPIRY),
  ...over,
})

beforeEach(() => {
  canned = null
  rows = []
  deposits = []
  nextId = 1
  queries.length = 0
})

describe('a lapsed reservation stops holding the strike once swept', () => {
  it('frees a strike three unrelated addresses filled and never used', async () => {
    add({ address: 'GTHROW1', notional_usd: 3_000 })
    add({ address: 'GTHROW2', notional_usd: 3_000 })
    add({ address: 'GTHROW3', notional_usd: 3_000 })

    // Before: a fourth address — who never named any of them — is refused.
    await expect(assertQuoteAllowed(policy())).rejects.toMatchObject({ code: 'strike_limit_exceeded' })

    const swept = await sweepLapsedReservations(async () => [])
    expect(swept).toMatchObject({ owners: 3, opened: 0, unused: 3, kept: 0 })
    expect(rows.every((r) => r.state === 'unused')).toBe(true)

    await expect(assertQuoteAllowed(policy())).resolves.toBeUndefined()
  })

  it('keeps counting a lapsed signature whose position is on chain', async () => {
    add({ address: 'GOPENER', notional_usd: 9_000 })

    const swept = await sweepLapsedReservations(async (address) =>
      address === 'GOPENER' ? [position()] : [],
    )
    expect(swept).toMatchObject({ opened: 1, unused: 0 })
    expect(rows[0].state).toBe('opened')

    // Opened and unreported still fills the strike, for everyone.
    await expect(assertQuoteAllowed(policy())).rejects.toMatchObject({ code: 'strike_limit_exceeded' })
  })

  it('keeps an owner pending when its positions cannot be read', async () => {
    add({ address: 'GDARK', notional_usd: 9_000 })
    add({ address: 'GLIGHT', notional_usd: 1 })

    const swept = await sweepLapsedReservations(async (address) => {
      if (address === 'GDARK') throw new Error('soroban rpc: 503')
      return []
    })

    expect(swept).toMatchObject({ owners: 2, kept: 1, unused: 1 })
    expect(rows.find((r) => r.address === 'GDARK')!.state).toBe('pending')
    expect(rows.find((r) => r.address === 'GLIGHT')!.state).toBe('unused')
  })

  it('leaves a still-valid reservation alone', async () => {
    add({ address: 'GLIVE', valid_until: Date.now() + 60_000 })
    const readPositions = vi.fn(async () => [])

    const swept = await sweepLapsedReservations(readPositions)

    expect(swept.owners).toBe(0)
    expect(readPositions).not.toHaveBeenCalled()
    expect(rows[0].state).toBe('pending')
  })

  it('settles a bounded number of owners per run, oldest lapse first', async () => {
    const now = Date.now()
    add({ address: 'GNEWER', valid_until: now - 60_000 })
    add({ address: 'GOLDEST', valid_until: now - 3_600_000 })
    add({ address: 'GOLDER', valid_until: now - 600_000 })
    const seen: string[] = []

    const swept = await sweepLapsedReservations(async (address) => {
      seen.push(address)
      return []
    }, 2)

    expect(swept.owners).toBe(2)
    expect(seen).toEqual(['GOLDEST', 'GOLDER'])
    expect(rows.find((r) => r.address === 'GNEWER')!.state).toBe('pending')
  })
})

// The deposit route writes the row that counts a position, then hands the
// quote's reservation over to it. A process that dies between the two leaves
// the reservation pending beside a row that already counts the same position,
// and once its signature lapses the sweep finds that position on chain.
describe('a deposit row written before a crash takes its reservation in the sweep', () => {
  const deposit = (over: Partial<Deposit> & { spotAtOpen?: number | null } = {}): Deposit => {
    const { spotAtOpen = 0.6, ...rest } = over
    return {
      address: 'GCRASH',
      underlying: 'XLM',
      subtype: 'call',
      amount: 10_000,
      metadata: {
        collateralAmount: 10_000,
        strikePrice: 0.3,
        expiryIso: EXPIRY,
        ...(spotAtOpen == null ? {} : { spotAtOpen }),
      },
      ...rest,
    }
  }

  it('counts the position once, as the deposit row', async () => {
    deposits.push(deposit()) // $6,000 at the quoted spot
    add({ address: 'GCRASH', notional_usd: 6_000 })

    // Both count it: $12,000 against a $10,000 strike.
    await expect(assertQuoteAllowed(policy())).rejects.toMatchObject({ code: 'strike_limit_exceeded' })

    const swept = await sweepLapsedReservations(async () => [position()])
    expect(swept).toMatchObject({ opened: 0, indexed: 1, unused: 0 })
    expect(rows[0].state).toBe('indexed')

    // Only the row does: $6,000 + $2,500 fits.
    await expect(assertQuoteAllowed(policy())).resolves.toBeUndefined()
  })

  it('keeps counting a reservation whose row cannot count the position in dollars', async () => {
    // An unpriced call adds nothing to a USD sum; the deposit route keeps its
    // reservation for the same reason.
    deposits.push(deposit({ spotAtOpen: null }))
    add({ address: 'GCRASH', notional_usd: 6_000 })

    const swept = await sweepLapsedReservations(async () => [position()])
    expect(swept).toMatchObject({ opened: 1, indexed: 0 })
    expect(rows[0].state).toBe('opened')
  })

  it('hands each row one reservation, and only a row nobody took', async () => {
    // One row was handed over properly; a second identical position opened
    // and its client never reported it.
    deposits.push(deposit())
    add({ address: 'GCRASH', state: 'indexed' })
    add({ address: 'GCRASH' })

    const swept = await sweepLapsedReservations(async () => [position(), position()])
    expect(swept).toMatchObject({ opened: 1, indexed: 0 })
    expect(rows[1].state).toBe('opened')
  })

  it('splits two lapsed reservations between a crashed row and an unreported position', async () => {
    deposits.push(deposit())
    add({ address: 'GCRASH' })
    add({ address: 'GCRASH' })

    const swept = await sweepLapsedReservations(async () => [position(), position()])
    expect(swept).toMatchObject({ opened: 1, indexed: 1, unused: 0 })
    expect(rows.map((r) => r.state).sort()).toEqual(['indexed', 'opened'])
  })
})

describe('the price a position opened at is the quote that opened it', () => {
  it('takes the latest signature on these terms that was live at open', async () => {
    const openedAt = Date.now() - 5 * 60_000
    // The time window is reservedOpenPrice's own SQL; the fake hands back the
    // candidates in the order that SQL asks for, so what is asserted below is
    // which one it picks and what it asked the database for.
    canned = () => ({
      rows: [
        { collateral: 999, notional_usd: 999, strike_price: 0.3, expiry_iso: EXPIRY }, // other terms
        { collateral: 10_000, notional_usd: 2_600, strike_price: 0.3, expiry_iso: EXPIRY }, // latest match
        { collateral: 10_000, notional_usd: 2_400, strike_price: 0.3, expiry_iso: EXPIRY },
      ],
    })

    const spot = await reservedOpenPrice({
      address: 'GW',
      underlying: 'XLM',
      type: 'call',
      collateral: 10_000,
      strike: 0.3,
      expiry: new Date(EXPIRY),
      openedAt,
    })

    expect(spot).toBeCloseTo(0.26, 10)
    const { sql, params } = queries.find((q) => q.sql.includes('notional_usd::float8'))!
    // Chosen by time — usable at the moment it opened — and never by state
    // or by the lowest id, which resolveLapsed's bookkeeping can mislabel.
    expect(sql).toMatch(/signed_at <= \$4::timestamptz/)
    expect(sql).toMatch(/valid_until >= \$4::timestamptz/)
    expect(sql).toMatch(/order by signed_at desc/)
    expect(sql).not.toMatch(/\bstate\b/)
    expect(params).toEqual(['GW', 'XLM', 'call', new Date(openedAt).toISOString()])
  })

  it('is unknown when no signature on these terms was live', async () => {
    canned = () => ({
      rows: [{ collateral: 5_000, notional_usd: 1_300, strike_price: 0.3, expiry_iso: EXPIRY }],
    })

    const spot = await reservedOpenPrice({
      address: 'GW',
      underlying: 'XLM',
      type: 'call',
      collateral: 10_000,
      strike: 0.3,
      expiry: new Date(EXPIRY),
      openedAt: Date.now(),
    })
    expect(spot).toBeNull()
  })
})

describe('indexed deposits count in dollars, as their reservations did', () => {
  it('sums the USD valuation, not the escrowed units, for both allowances', async () => {
    await assertQuoteAllowed(policy())
    const deposits = queries.filter((q) => q.sql.includes('from transactions t') && q.sql.includes('sum('))
    const wallet = deposits.find((q) => q.sql.includes("interval '30 days'"))!
    const strike = deposits.find((q) => q.sql.includes("interval '14 days'"))!
    for (const q of [wallet, strike]) {
      expect(q.sql).toMatch(/t\.amount \* \(t\.metadata->>'spotAtOpen'\)::numeric/)
      expect(q.sql).not.toMatch(/sum\(amount\)/)
    }
  })
})
