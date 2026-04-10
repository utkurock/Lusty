import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/debug/db
 * Quick health check that exercises the same code path the rest of the
 * app uses. Returns plain JSON describing what worked and what didn't,
 * so we can diagnose 500s on /api/leaderboard, /api/users/connect, etc.
 *
 * Safe to expose: it never reveals env vars or row contents, only
 * counts and error messages.
 */
export async function GET() {
  const result: Record<string, unknown> = {
    databaseUrlSet: Boolean(process.env.DATABASE_URL),
    sslRejectUnauthorizedRaw: process.env.DB_SSL_REJECT_UNAUTHORIZED ?? '(unset)',
    steps: [] as Array<{ step: string; ok: boolean; detail?: string }>,
  }
  const steps = result.steps as Array<{ step: string; ok: boolean; detail?: string }>

  // Step 1: get pool
  let pool
  try {
    pool = getPool()
    steps.push({ step: 'getPool', ok: true })
  } catch (e: any) {
    steps.push({ step: 'getPool', ok: false, detail: e?.message ?? 'unknown' })
    return NextResponse.json(result, { status: 500 })
  }

  // Step 2: trivial query (verifies network + auth + SSL)
  try {
    const r = await pool.query('select 1 as ok')
    steps.push({ step: 'select 1', ok: true, detail: `rows=${r.rows.length}` })
  } catch (e: any) {
    steps.push({ step: 'select 1', ok: false, detail: e?.message ?? 'unknown' })
    return NextResponse.json(result, { status: 500 })
  }

  // Step 3: ensureSchema (creates tables if missing)
  try {
    await ensureSchema()
    steps.push({ step: 'ensureSchema', ok: true })
  } catch (e: any) {
    steps.push({ step: 'ensureSchema', ok: false, detail: e?.message ?? 'unknown' })
    return NextResponse.json(result, { status: 500 })
  }

  // Step 4: count rows in core tables
  for (const tbl of ['users', 'transactions', 'admin_users', 'desk_notes']) {
    try {
      const r = await pool.query(`select count(*)::int as c from ${tbl}`)
      steps.push({ step: `count ${tbl}`, ok: true, detail: `count=${r.rows[0].c}` })
    } catch (e: any) {
      steps.push({ step: `count ${tbl}`, ok: false, detail: e?.message ?? 'unknown' })
    }
  }

  // Step 5: leaderboard view sanity check
  try {
    const r = await pool.query('select count(*)::int as c from leaderboard_view')
    steps.push({ step: 'leaderboard_view', ok: true, detail: `count=${r.rows[0].c}` })
  } catch (e: any) {
    steps.push({ step: 'leaderboard_view', ok: false, detail: e?.message ?? 'unknown' })
  }

  return NextResponse.json(result)
}
