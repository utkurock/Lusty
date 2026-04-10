import { Pool } from 'pg'

// Single pooled connection shared across route invocations.
// Node caches module state per process, so this is effectively a singleton.
declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined
  // eslint-disable-next-line no-var
  var __pgSchemaReady: boolean | undefined
}

export function getPool(): Pool {
  if (!global.__pgPool) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) throw new Error('DATABASE_URL not set')
    global.__pgPool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' },
      max: 3,
      // Supabase transaction pooler kills idle connections aggressively;
      // keep the pool small and timeouts tight so we fail fast instead of
      // hanging requests that would otherwise return 500.
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
    })
    global.__pgPool.on('error', (err) => {
      console.error('pg pool error:', err)
    })
  }
  return global.__pgPool
}

export async function ensureSchema(): Promise<void> {
  if (global.__pgSchemaReady) return
  const pool = getPool()
  console.log('ensureSchema: creating tables and views…')
  await pool.query(`
    create table if not exists desk_notes (
      id            bigserial primary key,
      generated_at  timestamptz not null default now(),
      price         numeric     not null,
      change_24h    numeric     not null,
      bias          text        not null check (bias in ('bullish','bearish','neutral')),
      headline      text        not null,
      bullets       jsonb       not null,
      suggestion    text        not null,
      source        text        not null default 'gemini'
    );
    create index if not exists desk_notes_generated_at_idx
      on desk_notes (generated_at desc);

    -- Users: track wallet connections
    create table if not exists users (
      address       text primary key,
      first_seen    timestamptz not null default now(),
      last_seen     timestamptz not null default now(),
      connect_count integer not null default 1
    );

    -- Transactions: all user actions (deposit, claim, faucet)
    create table if not exists transactions (
      id              bigserial primary key,
      address         text not null,
      type            text not null check (type in ('deposit','claim','faucet')),
      subtype         text,
      amount          numeric not null,
      asset           text not null,
      tx_hash         text,
      premium_hash    text,
      premium_amount  numeric,
      metadata        jsonb,
      created_at      timestamptz not null default now()
    );
    create index if not exists transactions_address_idx on transactions(address);
    create index if not exists transactions_created_at_idx on transactions(created_at desc);
    create index if not exists transactions_type_idx on transactions(type);

    -- Admin users whitelist
    create table if not exists admin_users (
      address  text primary key,
      added_at timestamptz not null default now(),
      label    text
    );
  `)

  // (Re)create leaderboard view.
  // PostgreSQL's `CREATE OR REPLACE VIEW` cannot add/rename/reorder columns
  // — it only allows changing the underlying query as long as the column
  // shape is identical. We add columns over time (total_swapped, swap_count,
  // etc.), so we have to DROP first to avoid:
  //   "cannot change name of view column ... to ..."
  // CASCADE so any dependent objects (none today, but be safe) are dropped too.
  await pool.query(`drop view if exists leaderboard_view cascade`)

  // Points formula:
  //   Vault deposits (non-swap): 1× deposited USD + 3× premium earned
  //   Swaps: 0.5× swap volume USD
  await pool.query(`
    create view leaderboard_view as
    select
      t.address,
      coalesce(sum(case when t.type = 'deposit' and (t.subtype is null or t.subtype != 'swap') then t.amount end), 0) as total_deposited,
      coalesce(sum(case when t.type = 'deposit' and (t.subtype is null or t.subtype != 'swap') then t.premium_amount end), 0) as total_premium,
      coalesce(sum(case when t.subtype = 'swap' then t.amount end), 0) as total_swapped,
      count(*) filter (where t.type = 'deposit' and (t.subtype is null or t.subtype != 'swap')) as deposit_count,
      count(*) filter (where t.subtype = 'swap') as swap_count,
      count(*) filter (where t.type = 'claim') as claim_count,
      count(*) filter (where t.type = 'faucet') as faucet_count,
      round(
        coalesce(sum(case when t.type = 'deposit' and (t.subtype is null or t.subtype != 'swap') then t.amount end), 0) +
        3 * coalesce(sum(case when t.type = 'deposit' and (t.subtype is null or t.subtype != 'swap') then t.premium_amount end), 0) +
        0.5 * coalesce(sum(case when t.subtype = 'swap' then t.amount end), 0)
      ) as points
    from transactions t
    group by t.address
  `)

  global.__pgSchemaReady = true
}
