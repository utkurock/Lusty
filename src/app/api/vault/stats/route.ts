import { NextResponse } from 'next/server'
import { Horizon } from '@stellar/stellar-sdk'
import { rateLimit } from '@/lib/rate-limit'
import {
  computeOpenBuckets,
  CALL_EPOCH_CAP_XLM,
  PUT_EPOCH_CAP_USD,
  EPOCHS_PER_MONTH,
} from '@/lib/vault-state'
import { LUSD_CODE, LUSD_ISSUER, LUSD_DISTRIBUTOR } from '@/lib/lusd'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const HORIZON =
  process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org'

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

    const openBuckets = await computeOpenBuckets()

    const buckets = openBuckets.map((b, i) => ({
      index: i,
      label: b.label,
      expiryIso: b.expiryIso,
      dateKey: b.dateKey,
      callXlm: b.callXlm,
      callCapXlm: CALL_EPOCH_CAP_XLM,
      callFull: b.callXlm >= CALL_EPOCH_CAP_XLM,
      putUsd: b.putUsd,
      putCapUsd: PUT_EPOCH_CAP_USD,
      putFull: b.putUsd >= PUT_EPOCH_CAP_USD,
    }))

    const callUtilizedXlm = buckets.reduce((a, b) => a + b.callXlm, 0)
    const putUtilizedUsd = buckets.reduce((a, b) => a + b.putUsd, 0)
    const callCapXlm = CALL_EPOCH_CAP_XLM * buckets.length
    const putCapUsd = PUT_EPOCH_CAP_USD * buckets.length
    const callUtilizationPct = Math.min(
      100,
      callCapXlm > 0 ? (callUtilizedXlm / callCapXlm) * 100 : 0
    )
    const putUtilizationPct = Math.min(
      100,
      putCapUsd > 0 ? (putUtilizedUsd / putCapUsd) * 100 : 0
    )

    // Wallet balances are display/debug only — best-effort.
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
        call: {
          utilizedXlm: callUtilizedXlm,
          capXlm: callCapXlm,
          utilizationPct: callUtilizationPct,
        },
        put: {
          utilizedUsd: putUtilizedUsd,
          capUsd: putCapUsd,
          utilizationPct: putUtilizationPct,
        },
        buckets,
        epochsPerMonth: EPOCHS_PER_MONTH,
        // Back-compat aliases (call side).
        utilizedXlm: callUtilizedXlm,
        capXlm: callCapXlm,
        utilizationPct: callUtilizationPct,
      },
      {
        headers: {
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
