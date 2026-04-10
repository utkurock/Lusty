import { NextResponse } from 'next/server'
import { getAllTransactions } from '@/lib/db-queries'
import { requireAdmin } from '@/lib/admin-auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const result = requireAdmin(req)
    if (result instanceof NextResponse) return result

    const url = new URL(req.url)
    const limit = Math.min(Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50), 200)
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0)
    const typeFilter = url.searchParams.get('type') ?? undefined
    const walletFilter = url.searchParams.get('wallet') ?? undefined

    const data = await getAllTransactions(limit, offset, {
      type: typeFilter,
      address: walletFilter,
    })
    return NextResponse.json({ ok: true, ...data })
  } catch (e: any) {
    return NextResponse.json(
      { error: 'admin transactions failed', detail: e?.message ?? 'unknown' },
      { status: 500 }
    )
  }
}
