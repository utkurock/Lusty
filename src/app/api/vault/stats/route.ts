import { NextResponse } from 'next/server'
import { Horizon } from '@stellar/stellar-sdk'
import { rateLimit } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const HORIZON =
  process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org'
const LUSD_CODE = process.env.NEXT_PUBLIC_LUSD_CODE ?? 'LUSD'
const LUSD_ISSUER = process.env.NEXT_PUBLIC_LUSD_ISSUER ?? ''
const LUSD_DISTRIBUTOR = process.env.NEXT_PUBLIC_LUSD_DISTRIBUTOR ?? ''

// XLM delta above this baseline is treated as "covered call collateral
// currently held by the vault". The baseline is the ambient XLM the
// distributor was seeded with so the UI doesn't report seed capital as
// user deposits.
const XLM_BASELINE = Number(process.env.VAULT_XLM_BASELINE ?? 30000)
const VAULT_CAP_XLM = Number(process.env.VAULT_CAP_XLM ?? 1_000_000)

export async function GET() {
  try {
    const rl = rateLimit('vault-stats:global', 60_000, 120)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 }
      )
    }

    if (!LUSD_DISTRIBUTOR) {
      return NextResponse.json({ error: 'vault not configured' }, { status: 500 })
    }
    const server = new Horizon.Server(HORIZON)
    const acc = await server.loadAccount(LUSD_DISTRIBUTOR)

    const xlmBalance = parseFloat(
      acc.balances.find((b: any) => b.asset_type === 'native')?.balance ?? '0'
    )
    const lusdBalance = parseFloat(
      acc.balances.find(
        (b: any) =>
          b.asset_code === LUSD_CODE && b.asset_issuer === LUSD_ISSUER
      )?.balance ?? '0'
    )

    const utilizedXlm = Math.max(0, xlmBalance - XLM_BASELINE)
    const utilizationPct = Math.min(100, (utilizedXlm / VAULT_CAP_XLM) * 100)

    return NextResponse.json(
      {
        ok: true,
        distributor: LUSD_DISTRIBUTOR,
        xlmBalance,
        lusdBalance,
        baseline: XLM_BASELINE,
        utilizedXlm,
        capXlm: VAULT_CAP_XLM,
        utilizationPct,
      },
      {
        headers: {
          // Force the browser/edge to never cache vault stats — utilization
          // must reflect the on-chain balance every time it's polled.
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        },
      }
    )
  } catch (e: any) {
    return NextResponse.json(
      { error: 'failed to read vault stats', detail: e?.message ?? 'unknown' },
      { status: 500 }
    )
  }
}
