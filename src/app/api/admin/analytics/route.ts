import { NextResponse } from 'next/server'
import { getAnalyticsSummary } from '@/lib/db-queries'
import { requireAdmin } from '@/lib/admin-auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const result = requireAdmin(req)
    if (result instanceof NextResponse) return result

    const summary = await getAnalyticsSummary()
    return NextResponse.json({ ok: true, summary })
  } catch (e: any) {
    return NextResponse.json(
      { error: 'admin analytics failed', detail: e?.message ?? 'unknown' },
      { status: 500 }
    )
  }
}
