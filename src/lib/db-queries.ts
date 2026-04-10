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
       rank() over (order by points desc) as rank,
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
     order by points desc
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
       (select count(*) + 1 from leaderboard_view lv2 where lv2.points > lv.points) as rank,
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
