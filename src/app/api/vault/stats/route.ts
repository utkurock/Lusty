import { NextResponse } from 'next/server'
import { Horizon } from '@stellar/stellar-sdk'
import { rateLimit } from '@/lib/rate-limit'
import {
  computeOpenBuckets,
  callEpochCap,
  putEpochCap,
  EPOCHS_PER_MONTH,
} from '@/lib/vault-state'
import { XLM, settleableUnderlying } from '@/lib/assets'
import { LUSD_CODE, LUSD_ISSUER, LUSD_DISTRIBUTOR } from '@/lib/lusd'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const HORIZON =
  process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org'

// Informational only — the distributor's seed XLM. No longer part of the
// utilization metric (see vault-state.ts / BUG-1); kept for the UI's debug
// readout and response back-compat.
const XLM_BASELINE = Number(process.env.VAULT_XLM_BASELINE ?? 30000)

// One book per request, for the same reason the portfolio route takes one:
// every figure below is a capacity or a fill in the asset's own units, and
// summing two assets' would produce a utilization percentage measured against
// nothing. `?asset=` names the book; absent means XLM.
export async function GET(req: Request) {
  try {
    const assetRaw = new URL(req.url).searchParams.get('asset')
    const asset = assetRaw ? settleableUnderlying(assetRaw) : XLM
    if (!asset) {
      return NextResponse.json(
        { error: `${assetRaw} has no vault to read`, code: 'asset_unavailable' },
        { status: 400 }
      )
    }

    const rl = rateLimit(`vault-stats:${asset.symbol}`, 60_000, 120)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 }
      )
    }

    if (!LUSD_DISTRIBUTOR) {
      return NextResponse.json({ error: 'vault not configured' }, { status: 500 })
    }

    const openBuckets = await computeOpenBuckets(new Date(), asset)

    // Both the fill and the cap are this asset's own. The field names still
    // say Xlm because Tranche 1's clients read them by that name; the number
    // in them is the underlying's, whichever underlying was asked for.
    const callEpoch = callEpochCap(asset)
    const putEpoch = putEpochCap(asset)

    const buckets = openBuckets.map((b, i) => ({
      index: i,
      label: b.label,
      expiryIso: b.expiryIso,
      dateKey: b.dateKey,
      callXlm: b.callXlm,
      callCapXlm: callEpoch,
      callFull: b.callXlm >= callEpoch,
      putUsd: b.putUsd,
      putCapUsd: putEpoch,
      putFull: b.putUsd >= putEpoch,
    }))

    const callUtilizedXlm = buckets.reduce((a, b) => a + b.callXlm, 0)
    const putUtilizedUsd = buckets.reduce((a, b) => a + b.putUsd, 0)
    const callCapXlm = callEpoch * buckets.length
    const putCapUsd = putEpoch * buckets.length
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
        underlying: asset.symbol,
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
