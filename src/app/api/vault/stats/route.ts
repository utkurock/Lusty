import { NextResponse } from 'next/server'
import { Horizon } from '@stellar/stellar-sdk'
import { rateLimit } from '@/lib/rate-limit'
import { computeOpenExposure } from '@/lib/vault-state'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const HORIZON =
  process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org'
const LUSD_CODE = process.env.NEXT_PUBLIC_LUSD_CODE ?? 'LUSD'
const LUSD_ISSUER = process.env.NEXT_PUBLIC_LUSD_ISSUER ?? ''
const LUSD_DISTRIBUTOR = process.env.NEXT_PUBLIC_LUSD_DISTRIBUTOR ?? ''

// Informational only — the distributor's seed XLM. No longer part of the
// utilization metric (see vault-state.ts / BUG-1); kept for the UI's debug
// readout and response back-compat.
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

    // Utilization is the open covered-call exposure recorded by the protocol
    // (BUG-1) — not the distributor's raw wallet balance. If the DB is
    // unreachable we cannot know real utilization, so we surface an error
    // rather than report a falsely-low number that would un-gate the UI.
    const exposure = await computeOpenExposure()
    const utilizedXlm = exposure.callXlm
    const utilizationPct = Math.min(100, (utilizedXlm / VAULT_CAP_XLM) * 100)

    // Wallet balances are display/debug only now. Best-effort: a Horizon
    // hiccup must not blank out the (DB-sourced) utilization the UI gates on.
    let xlmBalance = 0
    let lusdBalance = 0
    try {
      const server = new Horizon.Server(HORIZON)
      const acc = await server.loadAccount(LUSD_DISTRIBUTOR)
      xlmBalance = parseFloat(
        acc.balances.find((b: any) => b.asset_type === 'native')?.balance ?? '0'
      )
      lusdBalance = parseFloat(
        acc.balances.find(
          (b: any) =>
            b.asset_code === LUSD_CODE && b.asset_issuer === LUSD_ISSUER
        )?.balance ?? '0'
      )
    } catch (balErr: any) {
      console.warn('vault/stats: Horizon balance read failed (non-fatal)', balErr?.message)
    }

    return NextResponse.json(
      {
        ok: true,
        distributor: LUSD_DISTRIBUTOR,
        xlmBalance,
        lusdBalance,
        baseline: XLM_BASELINE,
        utilizedXlm,
        putLusd: exposure.putLusd,
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
