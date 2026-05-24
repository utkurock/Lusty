#!/usr/bin/env node
/**
 * Backfill processed_actions from historical transactions so on-chain hashes
 * that were settled before the idempotency ledger existed cannot be replayed
 * against the new endpoints.
 *
 *   - type='claim'                   → action_type='claim', source=metadata.depositHash
 *   - type='deposit' subtype='swap'  → action_type='swap',  source=tx_hash
 *
 * Idempotent: ON CONFLICT DO NOTHING. Safe to re-run.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/backfill-processed-actions.mjs
 */
import pg from 'pg'

const { Pool } = pg

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' },
  max: 2,
})

async function ensureTable() {
  await pool.query(`
    create table if not exists processed_actions (
      action_type   text not null check (action_type in ('claim','swap')),
      source_hash   text not null,
      reserved_at   timestamptz not null default now(),
      confirmed_at  timestamptz,
      payout_hash   text,
      primary key (action_type, source_hash)
    );
  `)
}

async function backfillClaims() {
  const res = await pool.query(`
    insert into processed_actions (action_type, source_hash, reserved_at, confirmed_at, payout_hash)
    select
      'claim',
      metadata->>'depositHash',
      created_at,
      created_at,
      tx_hash
    from transactions
    where type = 'claim'
      and metadata ? 'depositHash'
      and metadata->>'depositHash' is not null
    on conflict (action_type, source_hash) do nothing
    returning source_hash
  `)
  return res.rowCount ?? 0
}

async function backfillSwaps() {
  const res = await pool.query(`
    insert into processed_actions (action_type, source_hash, reserved_at, confirmed_at, payout_hash)
    select
      'swap',
      tx_hash,
      created_at,
      created_at,
      premium_hash
    from transactions
    where type = 'deposit'
      and subtype = 'swap'
      and tx_hash is not null
    on conflict (action_type, source_hash) do nothing
    returning source_hash
  `)
  return res.rowCount ?? 0
}

async function main() {
  await ensureTable()
  const claims = await backfillClaims()
  const swaps = await backfillSwaps()
  console.log(`backfilled: ${claims} claim hashes, ${swaps} swap hashes`)
  await pool.end()
}

main().catch((e) => {
  console.error('backfill failed:', e)
  process.exit(1)
})
