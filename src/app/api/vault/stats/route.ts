import { NextResponse } from 'next/server'
import { Horizon } from '@stellar/stellar-sdk'
import { rateLimit } from '@/lib/rate-limit'
import {
  computeEpochFlow,
  CALL_EPOCH_CAP_XLM,
  PUT_EPOCH_CAP_USD,
} from '@/lib/vault-state'

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

    // Utilization is the *current-epoch flow* recorded by the protocol — how
    // much each side has sold this epoch — read from the DB, not the
    // distributor's raw wallet balance (BUG-1). Resets every epoch, so stale
    // test positions from earlier epochs can't inflate it. The two sides are
    // independent: call (XLM) and put (USD) each have their own cap. If the DB
    // is unreachable we surface an error rather than report a falsely-low
    // number that would un-gate the UI.
    const flow = await computeEpochFlow()
    const callUtilizedXlm = flow.callXlm
    const putUtilizedUsd = flow.putUsd
    const callUtilizationPct = Math.min(
      100,
      CALL_EPOCH_CAP_XLM > 0 ? (callUtilizedXlm / CALL_EPOCH_CAP_XLM) * 100 : 0
    )
    const putUtilizationPct = Math.min(
      100,
      PUT_EPOCH_CAP_USD > 0 ? (putUtilizedUsd / PUT_EPOCH_CAP_USD) * 100 : 0
    )

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
        // Per-epoch, per-side utilization (the metric the UI/caps gate on).
        call: {
          utilizedXlm: callUtilizedXlm,
          capXlm: CALL_EPOCH_CAP_XLM,
          utilizationPct: callUtilizationPct,
        },
        put: {
          utilizedUsd: putUtilizedUsd,
          capUsd: PUT_EPOCH_CAP_USD,
          utilizationPct: putUtilizationPct,
        },
        epoch: {
          start: flow.epoch.start.toISOString(),
          end: flow.epoch.end.toISOString(),
          index: flow.epoch.index,
          monthKey: flow.epoch.monthKey,
        },
        // Back-compat aliases (call side) for older clients.
        utilizedXlm: callUtilizedXlm,
        capXlm: CALL_EPOCH_CAP_XLM,
        utilizationPct: callUtilizationPct,
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
