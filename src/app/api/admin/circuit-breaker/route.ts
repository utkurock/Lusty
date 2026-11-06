import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { ALL_BOOKS, listBreakers, setBreaker } from '@/lib/circuit-breaker'
import { allUnderlyings } from '@/lib/assets'

export const dynamic = 'force-dynamic'

/**
 * Admin view + manual override for the quoting circuit breakers (P1-8).
 * GET  → every switch: the desk-wide one first, then each book's that was set.
 * POST → { tripped: boolean, reason?: string, scope?: 'all' | <book symbol> }
 *        sets one switch manually. Without a scope it is the desk's.
 * Both admin-gated (x-admin-token).
 */
export async function GET(req: Request) {
  const auth = await requireAdmin(req)
  if (auth instanceof NextResponse) return auth
  try {
    const states = await listBreakers()
    return NextResponse.json({ ok: true, state: states[0], states })
  } catch (e: any) {
    return NextResponse.json(
      { error: 'failed to read breaker', detail: e?.message ?? 'unknown' },
      { status: 500 }
    )
  }
}

export async function POST(req: Request) {
  const auth = await requireAdmin(req)
  if (auth instanceof NextResponse) return auth

  let body: { tripped?: unknown; reason?: unknown; scope?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (typeof body.tripped !== 'boolean') {
    return NextResponse.json(
      { error: 'tripped (boolean) required' },
      { status: 400 }
    )
  }
  // A scope that names no book would set a switch nothing reads, and the admin
  // would believe a book halted that is still quoting.
  const books = allUnderlyings().map((a) => a.symbol)
  const scope =
    body.scope === undefined ? ALL_BOOKS : typeof body.scope === 'string' ? body.scope.trim() : ''
  const known = scope.toLowerCase() === ALL_BOOKS || books.includes(scope.toUpperCase())
  if (!known) {
    return NextResponse.json(
      { error: `scope must be '${ALL_BOOKS}' or one of ${books.join(', ')}` },
      { status: 400 }
    )
  }
  const reason =
    typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim().slice(0, 280)
      : body.tripped
        ? 'halted by admin'
        : null

  try {
    const state = await setBreaker({
      scope,
      tripped: body.tripped,
      reason,
      source: 'manual',
      updatedBy: auth,
    })
    return NextResponse.json({ ok: true, state })
  } catch (e: any) {
    return NextResponse.json(
      { error: 'failed to set breaker', detail: e?.message ?? 'unknown' },
      { status: 500 }
    )
  }
}
