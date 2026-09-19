import { NextResponse } from 'next/server'
import { ensureSchema, getPool } from '@/lib/db'
import { isValidStellarAddress } from '@/lib/utils'

/**
 * One wallet's crossings.
 *
 * The vault's activity feed is built from contract events, and a crossing is
 * not one: it is two classic payments either side of a server. So it is read
 * from the row the bridge writes, and shown beside that feed rather than
 * pretended into it.
 */
export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get('address') ?? ''
  if (!isValidStellarAddress(address)) {
    return NextResponse.json({ error: 'invalid address' }, { status: 400 })
  }

  try {
    await ensureSchema()
    const { rows } = await getPool().query(
      `select amount, asset, tx_hash, premium_hash, metadata, created_at
         from transactions
        where address = $1 and subtype = 'anchor_bridge'
        order by created_at desc
        limit 20`,
      [address]
    )

    return NextResponse.json(
      {
        crossings: rows.map((r: any) => ({
          amount: Number(r.amount),
          from: r.metadata?.from ?? r.asset,
          to: r.metadata?.to ?? null,
          direction: r.metadata?.direction ?? null,
          fundingHash: r.tx_hash,
          payoutHash: r.premium_hash,
          at: r.created_at,
        })),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (e: any) {
    console.error('anchor crossings read failed:', e?.message ?? e)
    return NextResponse.json({ error: 'history is unavailable right now' }, { status: 503 })
  }
}

export const dynamic = 'force-dynamic'
