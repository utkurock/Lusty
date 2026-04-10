import { NextResponse } from 'next/server'
import { getAllUsers } from '@/lib/db-queries'
import { requireAdmin } from '@/lib/admin-auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const result = requireAdmin(req)
    if (result instanceof NextResponse) return result

    const url = new URL(req.url)
    const limit = Math.min(Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50), 200)
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0)

    const data = await getAllUsers(limit, offset)
    return NextResponse.json({ ok: true, ...data })
  } catch (e: any) {
    return NextResponse.json(
      { error: 'admin users failed', detail: e?.message ?? 'unknown' },
      { status: 500 }
    )
  }
}
