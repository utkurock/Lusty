'use client'
import { useEffect, useState, useCallback } from 'react'

export interface VaultSideStats {
  /** Amount sold this epoch (XLM for calls, USD for puts). */
  utilized: number
  /** Per-epoch cap (XLM for calls, USD for puts). */
  cap: number
  utilizationPct: number
}

export interface VaultStatsPayload {
  // Per-epoch, per-side utilization.
  call: VaultSideStats
  put: VaultSideStats
  epoch: { start: string; end: string; index: number; monthKey: string }
  // Back-compat aliases (call side).
  utilizedXlm: number
  capXlm: number
  utilizationPct: number
  xlmBalance: number
  lusdBalance: number
  baseline: number
}

/**
 * Polls /api/vault/stats every `intervalMs` (default 30s). Always uses
 * `cache: 'no-store'` so the browser/CDN never serves a stale snapshot —
 * the value here drives both the "Current epoch utilization" widget and
 * the dynamic APR engine, so freshness matters.
 */
export function useVaultStats(intervalMs = 30_000) {
  const [stats, setStats] = useState<VaultStatsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/vault/stats', { cache: 'no-store' })
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
          epoch: d.epoch ?? { start: '', end: '', index: 0, monthKey: '' },
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
  }, [])

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
