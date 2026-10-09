import { NextResponse } from 'next/server'
import { getSecurityReports } from '@/lib/db-queries'
import { requireAdmin } from '@/lib/admin-auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const result = await requireAdmin(req)
    if (result instanceof NextResponse) return result

    const { searchParams } = new URL(req.url)
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10) || 20, 100)
    const offset = Math.max(parseInt(searchParams.get('offset') ?? '0', 10) || 0, 0)

    const data = await getSecurityReports(limit, offset)
    return NextResponse.json({ ok: true, ...data })
  } catch (e: any) {
    return NextResponse.json(
      { error: 'admin security reports failed', detail: e?.message ?? 'unknown' },
      { status: 500 }
    )
  }
}
