#!/usr/bin/env node
/**
 * Backfill processed_actions from historical transactions so on-chain hashes
 * that were settled before the idempotency ledger existed cannot be replayed
 * against the new endpoints.
 *
 *   - type='claim'                       → action_type='claim',   source=metadata.depositHash
 *   - type='deposit' subtype='swap'      → action_type='swap',    source=tx_hash
 *   - type='deposit' subtype=call|put    → action_type='deposit', source=tx_hash
 *
 * Idempotent: ON CONFLICT DO NOTHING. Safe to re-run. Also reports any
 * historical hash that was consumed by BOTH a deposit and a swap (intake
 * conflict — possible only before the cross-endpoint guard shipped).
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
      action_type   text not null check (action_type in ('deposit','claim','swap')),
      source_hash   text not null,
      reserved_at   timestamptz not null default now(),
      confirmed_at  timestamptz,
      payout_hash   text,
      primary key (action_type, source_hash)
    );
    alter table processed_actions
      drop constraint if exists processed_actions_action_type_check;
    alter table processed_actions
      add constraint processed_actions_action_type_check
      check (action_type in ('deposit','claim','swap'));
    create unique index if not exists processed_actions_intake_hash_uniq
      on processed_actions (source_hash)
      where action_type in ('deposit','swap');
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
    on conflict do nothing
    returning source_hash
  `)
  return res.rowCount ?? 0
}

async function backfillDeposits() {
  const res = await pool.query(`
    insert into processed_actions (action_type, source_hash, reserved_at, confirmed_at, payout_hash)
    select distinct on (tx_hash)
      'deposit',
      tx_hash,
      created_at,
      created_at,
      premium_hash
    from transactions
    where type = 'deposit'
      and subtype in ('call','put')
      and tx_hash is not null
    order by tx_hash, created_at asc
    on conflict do nothing
    returning source_hash
  `)
  return res.rowCount ?? 0
}

// Hashes consumed by BOTH a vault deposit and a swap before the intake guard
// existed. These need manual review — the ledger keeps whichever was inserted
// first and the unique index silently skips the other.
async function reportIntakeConflicts() {
  const res = await pool.query(`
    select d.tx_hash
    from transactions d
    join transactions s
      on s.tx_hash = d.tx_hash
     and s.type = 'deposit' and s.subtype = 'swap'
    where d.type = 'deposit' and d.subtype in ('call','put')
    group by d.tx_hash
  `)
  return res.rows.map((r) => r.tx_hash)
}

async function main() {
  await ensureTable()
  const claims = await backfillClaims()
  const swaps = await backfillSwaps()
  const deposits = await backfillDeposits()
  console.log(
    `backfilled: ${claims} claim hashes, ${swaps} swap hashes, ${deposits} deposit hashes`
  )
  const conflicts = await reportIntakeConflicts()
  if (conflicts.length > 0) {
    console.warn(
      `WARNING: ${conflicts.length} hash(es) were historically used as BOTH deposit and swap — manual review required:`
    )
    for (const h of conflicts) console.warn(`  ${h}`)
  }
  await pool.end()
}

main().catch((e) => {
  console.error('backfill failed:', e)
  process.exit(1)
})
