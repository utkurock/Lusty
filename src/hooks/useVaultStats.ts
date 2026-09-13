'use client'
import { useEffect, useState, useCallback } from 'react'
import type { UnderlyingSymbol } from '@/lib/assets'

export interface VaultSideStats {
  utilized: number
  cap: number
  utilizationPct: number
}

export interface VaultBucket {
  index: number
  label: string
  expiryIso: string
  dateKey: string
  callXlm: number
  callCapXlm: number
  callFull: boolean
  putUsd: number
  putCapUsd: number
  putFull: boolean
}

export interface VaultStatsPayload {
  call: VaultSideStats
  put: VaultSideStats
  buckets: VaultBucket[]
  epochsPerMonth: number
  // Back-compat aliases (call side).
  utilizedXlm: number
  capXlm: number
  utilizationPct: number
  xlmBalance: number
  lusdBalance: number
  baseline: number
}

// Polls /api/vault/stats (no-store) every `intervalMs`, for one book.
//
// The asset is a parameter because these are per-instance numbers: the caps,
// the per-expiry buckets and the utilization that prices the ladder all belong
// to one vault. Reading XLM's and rendering them on a BTC screen would show a
// book that is 0% full against a cap of 1.5 million, and quote against it.
export function useVaultStats(
  intervalMs = 30_000,
  asset: UnderlyingSymbol = 'XLM',
) {
  const [stats, setStats] = useState<VaultStatsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/vault/stats?asset=${asset}`, { cache: 'no-store' })
      const d = await res.json()
      if (d.ok) {
        setStats({
          call: {
            utilized: d.call?.utilizedXlm ?? d.utilizedXlm ?? 0,
            cap: d.call?.capXlm ?? d.capXlm ?? 0,
            utilizationPct: d.call?.utilizationPct ?? d.utilizationPct ?? 0,
          },
          put: {
            utilized: d.put?.utilizedUsd ?? 0,
            cap: d.put?.capUsd ?? 0,
            utilizationPct: d.put?.utilizationPct ?? 0,
          },
          buckets: Array.isArray(d.buckets) ? d.buckets : [],
          epochsPerMonth: d.epochsPerMonth ?? 3,
          utilizedXlm: d.utilizedXlm,
          capXlm: d.capXlm,
          utilizationPct: d.utilizationPct,
          xlmBalance: d.xlmBalance,
          lusdBalance: d.lusdBalance,
          baseline: d.baseline,
        })
        setError(null)
      } else {
        setError(d.error ?? 'unknown error')
      }
    } catch (e: any) {
      setError(e?.message ?? 'fetch failed')
    } finally {
      setLoading(false)
    }
  }, [asset])

  useEffect(() => {
    load()
    const id = setInterval(load, intervalMs)
    const onVisible = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load, intervalMs])

  return { stats, loading, error, refresh: load }
}
