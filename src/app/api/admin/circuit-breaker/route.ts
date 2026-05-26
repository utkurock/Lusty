import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { getBreakerState, setBreaker } from '@/lib/circuit-breaker'

export const dynamic = 'force-dynamic'

/**
 * Admin view + manual override for the deposit circuit breaker (P1-8).
 * GET  → current state.
 * POST → { tripped: boolean, reason?: string } sets the breaker manually.
 * Both admin-gated (x-admin-token).
 */
export async function GET(req: Request) {
  const auth = requireAdmin(req)
  if (auth instanceof NextResponse) return auth
  try {
    const state = await getBreakerState()
    return NextResponse.json({ ok: true, state })
  } catch (e: any) {
    return NextResponse.json(
      { error: 'failed to read breaker', detail: e?.message ?? 'unknown' },
      { status: 500 }
    )
  }
}

export async function POST(req: Request) {
  const auth = requireAdmin(req)
  if (auth instanceof NextResponse) return auth

  let body: { tripped?: unknown; reason?: unknown }
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
  const reason =
    typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim().slice(0, 280)
      : body.tripped
        ? 'halted by admin'
        : null

  try {
    const state = await setBreaker({
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
