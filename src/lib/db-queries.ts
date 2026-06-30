import { getPool, ensureSchema } from './db'

// ── User operations ────────────────────────────────────────────────

export async function upsertUser(address: string) {
  await ensureSchema()
  const pool = getPool()
  await pool.query(
    `insert into users (address)
     values ($1)
     on conflict (address) do update
       set last_seen = now(),
           connect_count = users.connect_count + 1`,
    [address]
  )
}

// ── Transaction logging ────────────────────────────────────────────

interface LogTxParams {
  address: string
  type: 'deposit' | 'claim' | 'faucet'
  subtype?: string | null
  amount: number
  asset: string
  txHash?: string | null
  premiumHash?: string | null
  premiumAmount?: number | null
  metadata?: Record<string, unknown> | null
}

export async function logTransaction(params: LogTxParams) {
  await ensureSchema()
  // Ensure user exists
  await upsertUser(params.address)
  const pool = getPool()
  await pool.query(
    `insert into transactions
       (address, type, subtype, amount, asset, tx_hash, premium_hash, premium_amount, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      params.address,
      params.type,
      params.subtype ?? null,
      params.amount,
      params.asset,
      params.txHash ?? null,
      params.premiumHash ?? null,
      params.premiumAmount ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
    ]
  )
}

// ── Deposit lookup ─────────────────────────────────────────────────

export interface DepositRecord {
  address: string
  type: 'call' | 'put'
  collateralAmount: number
  strikePrice: number | null
  expiryIso: string | null
  apr: number | null
  daysToExpiry: number | null
  premiumAmount: number | null
  createdAt: string
}

/**
 * Canonical, server-trusted view of a deposit. Used by the claim endpoint
 * to bind strike/type/expiry/collateral to what was recorded at deposit
 * time, instead of trusting whatever the client sends at claim. Returns
 * null if no row matches (claim should 404 in that case, fail-closed).
 *
 * `expiryIso` is read directly from metadata when present (new positions),
 * otherwise derived from created_at + metadata.daysToExpiry for legacy
 * positions that pre-date explicit-expiry storage.
 */
export async function getDepositRecord(
  depositHash: string
): Promise<DepositRecord | null> {
  if (!depositHash) return null
  await ensureSchema()
  const pool = getPool()
  const res = await pool.query(
    `select address, subtype, amount, premium_amount, metadata, created_at
     from transactions
     where type = 'deposit'
       and (subtype = 'call' or subtype = 'put')
       and tx_hash = $1
     order by created_at asc
     limit 1`,
    [depositHash]
  )
  if (res.rows.length === 0) return null
  const r = res.rows[0]
  const meta = (r.metadata ?? {}) as Record<string, unknown>

  const strikeRaw = meta.strikePrice
  const strikePrice =
    typeof strikeRaw === 'number' && isFinite(strikeRaw) ? strikeRaw : null

  const aprRaw = meta.apr
  const apr =
    typeof aprRaw === 'number' && isFinite(aprRaw) ? aprRaw : null

  const dteRaw = meta.daysToExpiry
  const daysToExpiry =
    typeof dteRaw === 'number' && isFinite(dteRaw) ? dteRaw : null

  const collateralRaw = meta.collateralAmount
  const collateralAmount =
    typeof collateralRaw === 'number' && isFinite(collateralRaw)
      ? collateralRaw
      : null

  // expiry: prefer the explicit ISO if stored at deposit; fall back to
  // created_at + daysToExpiry for legacy rows that don't have it.
  const explicitExpiry =
    typeof meta.expiryIso === 'string' && meta.expiryIso ? meta.expiryIso : null
  let expiryIso: string | null = explicitExpiry
  if (!expiryIso && daysToExpiry !== null) {
    const createdMs = new Date(r.created_at).getTime()
    if (isFinite(createdMs)) {
      expiryIso = new Date(createdMs + daysToExpiry * 86400_000).toISOString()
    }
  }

  return {
    address: r.address,
    type: r.subtype as 'call' | 'put',
    collateralAmount:
      collateralAmount !== null ? collateralAmount : parseFloat(r.amount),
    strikePrice,
    expiryIso,
    apr,
    daysToExpiry,
    premiumAmount: r.premium_amount !== null ? parseFloat(r.premium_amount) : null,
    createdAt: r.created_at,
  }
}

// ── User positions (server-side, cross-device) ─────────────────────
//
// The dashboard reads positions from here (the shared DB) rather than from
// browser localStorage, so a user sees and can claim their positions from ANY
// device. Every deposit is logged at deposit time; settled status comes from
// the processed_actions claim ledger.

const POS_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
function expiryLabelFromIso(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!isFinite(d.getTime())) return '—'
  return `${POS_MONTHS[d.getUTCMonth()]}_${String(d.getUTCDate()).padStart(2, '0')}`
}

export interface DbPosition {
  id: string
  address: string
  type: 'call' | 'put'
  asset: string
  collateralAmount: number
  strikePrice: number | null
  apr: number | null
  premium: number
  depositHash: string
  premiumHash: string | null
  expiryIso: string | null
  expiryLabel: string
  daysToExpirySnapshot: number | null
  createdAt: number
  settled: boolean
  payoutHash: string | null
}

export async function getPositionsForAddress(address: string): Promise<DbPosition[]> {
  if (!address) return []
  await ensureSchema()
  const pool = getPool()
  const res = await pool.query(
    `select t.tx_hash, t.subtype, t.amount, t.asset, t.premium_hash,
            t.premium_amount, t.metadata, t.created_at,
            (pa.confirmed_at is not null) as settled, pa.payout_hash
     from transactions t
     left join processed_actions pa
       on pa.action_type = 'claim' and pa.source_hash = t.tx_hash
     where t.address = $1
       and t.type = 'deposit'
       and (t.subtype = 'call' or t.subtype = 'put')
     order by t.created_at desc`,
    [address]
  )

  return res.rows.map((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    const numOrNull = (v: unknown) =>
      typeof v === 'number' && isFinite(v) ? v : null

    const strikePrice = numOrNull(meta.strikePrice)
    const apr = numOrNull(meta.apr)
    const daysToExpiry = numOrNull(meta.daysToExpiry)
    const collateral = numOrNull(meta.collateralAmount)

    let expiryIso =
      typeof meta.expiryIso === 'string' && meta.expiryIso ? meta.expiryIso : null
    if (!expiryIso && daysToExpiry !== null) {
      const createdMs = new Date(r.created_at).getTime()
      if (isFinite(createdMs)) {
        expiryIso = new Date(createdMs + daysToExpiry * 86400_000).toISOString()
      }
    }

    return {
      id: r.tx_hash,
      address,
      type: r.subtype as 'call' | 'put',
      asset: r.asset ?? (r.subtype === 'call' ? 'XLM' : 'LUSD'),
      collateralAmount: collateral !== null ? collateral : parseFloat(r.amount),
      strikePrice,
      apr,
      premium: r.premium_amount !== null ? parseFloat(r.premium_amount) : 0,
      depositHash: r.tx_hash,
      premiumHash: r.premium_hash ?? null,
      expiryIso,
      expiryLabel: expiryLabelFromIso(expiryIso),
      daysToExpirySnapshot: daysToExpiry,
      createdAt: new Date(r.created_at).getTime(),
      settled: r.settled === true,
      payoutHash: r.payout_hash ?? null,
    }
  })
}

// ── Leaderboard ────────────────────────────────────────────────────

export interface LeaderRow {
  rank: number
  address: string
  points: number
  totalDeposited: number
  totalPremium: number
  totalSwapped: number
  depositCount: number
  swapCount: number
  claimCount: number
  faucetCount: number
}

export async function getLeaderboard(
  limit = 50,
  offset = 0
): Promise<{ rows: LeaderRow[]; total: number }> {
  await ensureSchema()
  const pool = getPool()

  const countRes = await pool.query('select count(*) from leaderboard_view')
  const total = parseInt(countRes.rows[0].count, 10)

  const res = await pool.query(
    `select
       row_number() over (order by points desc, total_deposited desc, address asc) as rank,
       address,
       points::numeric as points,
       total_deposited::numeric as total_deposited,
       total_premium::numeric as total_premium,
       total_swapped::numeric as total_swapped,
       deposit_count::int as deposit_count,
       swap_count::int as swap_count,
       claim_count::int as claim_count,
       faucet_count::int as faucet_count
     from leaderboard_view
     order by points desc, total_deposited desc, address asc
     limit $1 offset $2`,
    [limit, offset]
  )

  return {
    rows: res.rows.map((r: any) => ({
      rank: parseInt(r.rank, 10),
      address: r.address,
      points: parseFloat(r.points),
      totalDeposited: parseFloat(r.total_deposited),
      totalPremium: parseFloat(r.total_premium),
      totalSwapped: parseFloat(r.total_swapped),
      depositCount: r.deposit_count,
      swapCount: r.swap_count,
      claimCount: r.claim_count,
      faucetCount: r.faucet_count,
    })),
    total,
  }
}

export async function getUserStats(address: string): Promise<LeaderRow | null> {
  await ensureSchema()
  const pool = getPool()
  const res = await pool.query(
    `select
       (select count(*) + 1 from leaderboard_view lv2
          where lv2.points > lv.points
             or (lv2.points = lv.points and lv2.total_deposited > lv.total_deposited)
             or (lv2.points = lv.points and lv2.total_deposited = lv.total_deposited and lv2.address < lv.address)
       ) as rank,
       lv.address,
       lv.points::numeric as points,
       lv.total_deposited::numeric as total_deposited,
       lv.total_premium::numeric as total_premium,
       lv.total_swapped::numeric as total_swapped,
       lv.deposit_count::int as deposit_count,
       lv.swap_count::int as swap_count,
       lv.claim_count::int as claim_count,
       lv.faucet_count::int as faucet_count
     from leaderboard_view lv
     where lv.address = $1`,
    [address]
  )
  if (res.rows.length === 0) return null
  const r = res.rows[0]
  return {
    rank: parseInt(r.rank, 10),
    address: r.address,
    points: parseFloat(r.points),
    totalDeposited: parseFloat(r.total_deposited),
    totalPremium: parseFloat(r.total_premium),
    totalSwapped: parseFloat(r.total_swapped),
    depositCount: r.deposit_count,
    swapCount: r.swap_count,
    claimCount: r.claim_count,
    faucetCount: r.faucet_count,
  }
}

// ── Admin ──────────────────────────────────────────────────────────

export async function isAdmin(address: string): Promise<boolean> {
  // Env var fallback: ADMIN_WALLETS="GABC...,GDEF..." (comma-separated)
  // Lets the admin panel work without needing to seed the database first.
  const envList = (process.env.ADMIN_WALLETS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (envList.includes(address)) return true

  try {
    await ensureSchema()
    const pool = getPool()
    const res = await pool.query(
      'select 1 from admin_users where address = $1',
      [address]
    )
    return res.rows.length > 0
  } catch (e) {
    // DB unreachable — env var was the only path; deny.
    console.error('isAdmin: DB lookup failed', e)
    return false
  }
}

export interface AdminStats {
  totalUsers: number
  totalTransactions: number
  totalDeposited: number
  totalPremium: number
  last24hUsers: number
  last24hTransactions: number
}

export async function getAdminStats(): Promise<AdminStats> {
  await ensureSchema()
  const pool = getPool()
  const [users, txs, volumes, recentUsers, recentTxs] = await Promise.all([
    pool.query('select count(*) from users'),
    pool.query('select count(*) from transactions'),
    pool.query(
      `select
         coalesce(sum(case when type = 'deposit' then amount end), 0) as total_deposited,
         coalesce(sum(case when type = 'deposit' then premium_amount end), 0) as total_premium
       from transactions`
    ),
    pool.query("select count(*) from users where last_seen > now() - interval '24 hours'"),
    pool.query("select count(*) from transactions where created_at > now() - interval '24 hours'"),
  ])

  return {
    totalUsers: parseInt(users.rows[0].count, 10),
    totalTransactions: parseInt(txs.rows[0].count, 10),
    totalDeposited: parseFloat(volumes.rows[0].total_deposited),
    totalPremium: parseFloat(volumes.rows[0].total_premium),
    last24hUsers: parseInt(recentUsers.rows[0].count, 10),
    last24hTransactions: parseInt(recentTxs.rows[0].count, 10),
  }
}

export async function getAllUsers(limit = 50, offset = 0) {
  await ensureSchema()
  const pool = getPool()
  const countRes = await pool.query('select count(*) from users')
  const total = parseInt(countRes.rows[0].count, 10)

  const res = await pool.query(
    `select
       u.address,
       u.first_seen,
       u.last_seen,
       u.connect_count,
       coalesce(lv.total_deposited, 0)::numeric as total_deposited,
       coalesce(lv.total_premium, 0)::numeric as total_premium,
       coalesce(lv.points, 0)::numeric as points,
       coalesce(lv.deposit_count, 0)::int as deposit_count
     from users u
     left join leaderboard_view lv on lv.address = u.address
     order by u.last_seen desc
     limit $1 offset $2`,
    [limit, offset]
  )

  return {
    rows: res.rows.map((r: any) => ({
      address: r.address,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      connectCount: r.connect_count,
      totalDeposited: parseFloat(r.total_deposited),
      totalPremium: parseFloat(r.total_premium),
      points: parseFloat(r.points),
      depositCount: r.deposit_count,
    })),
    total,
  }
}

export async function getAllTransactions(
  limit = 50,
  offset = 0,
  filters?: { type?: string; address?: string }
) {
  await ensureSchema()
  const pool = getPool()

  const conditions: string[] = []
  const params: unknown[] = []
  let paramIdx = 1

  if (filters?.type) {
    conditions.push(`type = $${paramIdx++}`)
    params.push(filters.type)
  }
  if (filters?.address) {
    conditions.push(`address = $${paramIdx++}`)
    params.push(filters.address)
  }

  const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : ''

  const countRes = await pool.query(
    `select count(*) from transactions ${where}`,
    params
  )
  const total = parseInt(countRes.rows[0].count, 10)

  const res = await pool.query(
    `select * from transactions ${where}
     order by created_at desc
     limit $${paramIdx++} offset $${paramIdx}`,
    [...params, limit, offset]
  )

  return {
    rows: res.rows.map((r: any) => ({
      id: r.id,
      address: r.address,
      type: r.type,
      subtype: r.subtype,
      amount: parseFloat(r.amount),
      asset: r.asset,
      txHash: r.tx_hash,
      premiumHash: r.premium_hash,
      premiumAmount: r.premium_amount ? parseFloat(r.premium_amount) : null,
      metadata: r.metadata,
      createdAt: r.created_at,
    })),
    total,
  }
}

// ── Analytics ──────────────────────────────────────────────────────

interface LogEventParams {
  event: string
  address?: string | null
  path?: string | null
  sessionId?: string | null
  metadata?: Record<string, unknown> | null
}

export async function logEvent(params: LogEventParams) {
  await ensureSchema()
  const pool = getPool()
  await pool.query(
    `insert into analytics_events (event, address, path, session_id, metadata)
     values ($1, $2, $3, $4, $5)`,
    [
      params.event,
      params.address ?? null,
      params.path ?? null,
      params.sessionId ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
    ]
  )
}

export interface AnalyticsSummary {
  totalEvents: number
  pageViews: number
  uniqueSessions: number
  uniqueVisitors24h: number
  walletConnects: number
  eventsByName: { event: string; count: number }[]
  topPaths: { path: string; count: number }[]
  // Action funnel derived from the transactions table (on-chain proof).
  actions: {
    deposits: number
    claims: number
    faucet: number
    swaps: number
    uniqueDepositors: number
  }
  // Daily page-view series for the last 14 days, oldest first.
  daily: { day: string; pageViews: number; sessions: number }[]
}

export async function getAnalyticsSummary(): Promise<AnalyticsSummary> {
  await ensureSchema()
  const pool = getPool()

  const [
    totals,
    byName,
    paths,
    actions,
    uniqueDepositors,
    daily,
  ] = await Promise.all([
    pool.query(`
      select
        count(*)                                                          as total_events,
        count(*) filter (where event = 'page_view')                      as page_views,
        count(distinct session_id)                                       as unique_sessions,
        count(distinct session_id) filter (where created_at > now() - interval '24 hours') as unique_24h,
        count(*) filter (where event = 'wallet_connect')                 as wallet_connects
      from analytics_events
    `),
    pool.query(`
      select event, count(*)::int as count
      from analytics_events
      group by event
      order by count desc
    `),
    pool.query(`
      select coalesce(path, '(unknown)') as path, count(*)::int as count
      from analytics_events
      where event = 'page_view'
      group by path
      order by count desc
      limit 10
    `),
    pool.query(`
      select
        count(*) filter (where type = 'deposit' and (subtype is null or subtype != 'swap')) as deposits,
        count(*) filter (where type = 'claim')                                              as claims,
        count(*) filter (where type = 'faucet')                                             as faucet,
        count(*) filter (where subtype = 'swap')                                            as swaps
      from transactions
    `),
    pool.query(`
      select count(distinct address) as c
      from transactions
      where type = 'deposit' and (subtype is null or subtype != 'swap')
    `),
    pool.query(`
      select
        to_char(d.day, 'YYYY-MM-DD') as day,
        coalesce(count(e.*) filter (where e.event = 'page_view'), 0)::int as page_views,
        coalesce(count(distinct e.session_id), 0)::int as sessions
      from generate_series(
        (now() - interval '13 days')::date, now()::date, interval '1 day'
      ) as d(day)
      left join analytics_events e
        on e.created_at >= d.day and e.created_at < d.day + interval '1 day'
      group by d.day
      order by d.day asc
    `),
  ])

  const t = totals.rows[0]
  const a = actions.rows[0]
  return {
    totalEvents: parseInt(t.total_events, 10),
    pageViews: parseInt(t.page_views, 10),
    uniqueSessions: parseInt(t.unique_sessions, 10),
    uniqueVisitors24h: parseInt(t.unique_24h, 10),
    walletConnects: parseInt(t.wallet_connects, 10),
    eventsByName: byName.rows.map((r: any) => ({ event: r.event, count: r.count })),
    topPaths: paths.rows.map((r: any) => ({ path: r.path, count: r.count })),
    actions: {
      deposits: parseInt(a.deposits, 10),
      claims: parseInt(a.claims, 10),
      faucet: parseInt(a.faucet, 10),
      swaps: parseInt(a.swaps, 10),
      uniqueDepositors: parseInt(uniqueDepositors.rows[0].c, 10),
    },
    daily: daily.rows.map((r: any) => ({
      day: r.day,
      pageViews: r.page_views,
      sessions: r.sessions,
    })),
  }
}

// ── Feedback ───────────────────────────────────────────────────────

interface InsertFeedbackParams {
  address?: string | null
  rating?: number | null
  category?: string | null
  message: string
  path?: string | null
}

export async function insertFeedback(params: InsertFeedbackParams) {
  await ensureSchema()
  const pool = getPool()
  await pool.query(
    `insert into feedback (address, rating, category, message, path)
     values ($1, $2, $3, $4, $5)`,
    [
      params.address ?? null,
      params.rating ?? null,
      params.category ?? null,
      params.message,
      params.path ?? null,
    ]
  )
}

export async function getFeedback(limit = 50, offset = 0) {
  await ensureSchema()
  const pool = getPool()

  const countRes = await pool.query('select count(*) from feedback')
  const total = parseInt(countRes.rows[0].count, 10)

  const [rows, summary] = await Promise.all([
    pool.query(
      `select * from feedback order by created_at desc limit $1 offset $2`,
      [limit, offset]
    ),
    pool.query(`
      select
        count(*)::int                                  as total,
        round(avg(rating)::numeric, 2)                 as avg_rating,
        count(*) filter (where rating is not null)::int as rated_count
      from feedback
    `),
  ])

  const s = summary.rows[0]
  return {
    rows: rows.rows.map((r: any) => ({
      id: r.id,
      address: r.address,
      rating: r.rating,
      category: r.category,
      message: r.message,
      path: r.path,
      createdAt: r.created_at,
    })),
    total,
    summary: {
      total: s.total,
      avgRating: s.avg_rating !== null ? parseFloat(s.avg_rating) : null,
      ratedCount: s.rated_count,
    },
  }
}
