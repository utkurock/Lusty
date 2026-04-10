import { NextResponse } from 'next/server'
import { getAdminStats } from '@/lib/db-queries'
import { requireAdmin } from '@/lib/admin-auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const result = requireAdmin(req)
    if (result instanceof NextResponse) return result

    const stats = await getAdminStats()
    return NextResponse.json({ ok: true, stats })
  } catch (e: any) {
    return NextResponse.json(
      { error: 'admin stats failed', detail: e?.message ?? 'unknown' },
      { status: 500 }
    )
  }
}
