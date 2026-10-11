// Shared fakes for the payout-route tests (payout-*.test.ts).
// ===========================================================
// The payout routes are tested end to end through their real proof, replay
// guard, flow ledger and SDK call builders. Only the two edges are faked: the
// database, as an in-memory processed_actions + swap_flows with the same
// uniqueness the schema enforces, and Horizon, as a fetch that answers exact
// paths only — so whatever path the SDK builds from a posted hash is the path
// that is looked up, and anything else is a 404.

import { Networks, TransactionBuilder } from '@stellar/stellar-sdk'

type Row = Record<string, any>

/** processed_actions and swap_flows, enforced the way db.ts declares them. */
export function fakeDb() {
  const actions: Row[] = []
  const flows: Row[] = []

  async function query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    const none = { rows: [], rowCount: 0 }

    if (s === 'begin' || s === 'commit' || s === 'rollback' || s === 'select 1') return none
    if (s.includes('pg_advisory_xact_lock')) return none

    if (s.startsWith('insert into processed_actions')) {
      const [type, hash] = params
      const pk = actions.some((r) => r.type === type && r.hash === hash)
      const intake =
        (type === 'deposit' || type === 'swap') &&
        actions.some((r) => (r.type === 'deposit' || r.type === 'swap') && r.hash === hash)
      if (pk || intake) return none
      actions.push({ type, hash, confirmed: false, payout: null })
      return { rows: [{ source_hash: hash }], rowCount: 1 }
    }
    if (s.startsWith('delete from processed_actions')) {
      const i = actions.findIndex((r) => r.type === params[0] && r.hash === params[1])
      if (i >= 0) actions.splice(i, 1)
      return none
    }
    if (s.startsWith('update processed_actions')) {
      for (const r of actions) {
        if (r.type === params[0] && r.hash === params[1]) {
          r.payout = params[2]
          if (s.includes('confirmed_at = now()')) r.confirmed = true
        }
      }
      return none
    }

    if (s.startsWith('select 1 from swap_flows where funding_hash')) {
      const hit = flows.some((f) => f.hash === params[0])
      return { rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 }
    }
    if (s.includes('from swap_flows where address')) {
      const mine = flows.filter((f) => f.address === params[0])
      const c = mine.reduce((a, f) => a + f.xlm_in - f.xlm_out, 0)
      return { rows: [{ c: String(c) }], rowCount: 1 }
    }
    if (s.includes('from swap_flows where created_at')) {
      const since = Date.now() - 86_400_000
      const sum = flows.filter((f) => f.created_at > since).reduce((a, f) => a + f.xlm_out, 0)
      return { rows: [{ s: String(sum) }], rowCount: 1 }
    }
    if (s.startsWith('insert into swap_flows')) {
      const [hash, address, direction, xlmIn, xlmOut] = params
      if (flows.some((f) => f.hash === hash)) return none
      flows.push({
        hash,
        address,
        direction,
        xlm_in: Number(xlmIn),
        xlm_out: Number(xlmOut),
        status: 'pending',
        created_at: Date.now(),
      })
      return { rows: [{ funding_hash: hash }], rowCount: 1 }
    }
    if (s.startsWith('delete from swap_flows')) {
      const i = flows.findIndex((f) => f.hash === params[0] && f.status === 'pending')
      if (i >= 0) flows.splice(i, 1)
      return none
    }
    if (s.startsWith('update swap_flows')) {
      for (const f of flows) if (f.hash === params[0]) f.status = 'settled'
      return none
    }
    throw new Error(`fakeDb: unhandled SQL: ${s.slice(0, 80)}`)
  }

  const pool = {
    query,
    connect: async () => ({ query, release: () => {} }),
  }
  return {
    pool,
    actions,
    flows,
    reset() {
      actions.length = 0
      flows.length = 0
    },
  }
}

export interface FakeAccount {
  id: string
  balances: Row[]
  subentry_count?: number
}

/** A Horizon that answers exact paths only, and counts what it was asked. */
export function fakeHorizon() {
  const txs = new Map<string, { tx: Row; operations: Row[] }>()
  const accounts = new Map<string, FakeAccount>()
  const paths: string[] = []
  const submitted: ReturnType<typeof TransactionBuilder.fromXDR>[] = []
  let submitAnswer: () => Response = () =>
    json(200, { hash: 'f'.repeat(64), successful: true })

  function json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }

  async function fetchImpl(input: any, init?: any): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    paths.push(`${method} ${url.pathname}`)

    if (method === 'POST' && url.pathname === '/transactions') {
      const raw = new URLSearchParams(String(init?.body ?? '')).get('tx') ?? ''
      submitted.push(TransactionBuilder.fromXDR(raw, Networks.TESTNET))
      return submitAnswer()
    }
    let m = url.pathname.match(/^\/transactions\/([^/]+)$/)
    if (m && txs.has(m[1])) return json(200, txs.get(m[1])!.tx)
    m = url.pathname.match(/^\/transactions\/([^/]+)\/operations$/)
    if (m && txs.has(m[1])) {
      return json(200, { _links: {}, _embedded: { records: txs.get(m[1])!.operations } })
    }
    m = url.pathname.match(/^\/accounts\/([^/]+)$/)
    if (m && accounts.has(m[1])) {
      const a = accounts.get(m[1])!
      return json(200, {
        id: a.id,
        account_id: a.id,
        sequence: '100',
        subentry_count: a.subentry_count ?? 0,
        balances: a.balances,
        thresholds: {},
        flags: {},
        signers: [],
        data: {},
        data_attr: {},
      })
    }
    return json(404, { status: 404, title: 'Resource Missing' })
  }

  return {
    fetch: fetchImpl,
    txs,
    accounts,
    paths,
    submitted,
    /** Payouts the distributor sent. */
    payouts: () => submitted.length,
    answerSubmitWith(fn: () => Response) {
      submitAnswer = fn
    },
    json,
    reset() {
      txs.clear()
      accounts.clear()
      paths.length = 0
      submitted.length = 0
      submitAnswer = () => json(200, { hash: 'f'.repeat(64), successful: true })
    },
  }
}
