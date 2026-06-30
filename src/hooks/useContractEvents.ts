'use client'
import { useEffect, useState, useCallback } from 'react'

export interface VaultEvent {
  kind: 'deposit' | 'settle' | 'fund'
  id: string | null
  ledger: number
  at: string
  contractId: string
  txHash?: string
  owner?: string
  amountXlm?: number
  strikeUsd?: number
  expiry?: number
  premiumCash?: number
  outcome?: string
  priceUsd?: number
  from?: string
  amountCash?: number
}

// Polls /api/vault/events (no-store) for the vault contract's on-chain events.
// Visibility-aware so a backgrounded tab stops hammering the RPC, mirroring
// useVaultStats.
export function useContractEvents(intervalMs = 15_000) {
  const [events, setEvents] = useState<VaultEvent[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/vault/events', { cache: 'no-store' })
      const json = await res.json()
      if (json?.ok && Array.isArray(json.events)) setEvents(json.events)
    } catch {
      /* feed is non-critical — keep the last good snapshot */
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

  return { events, loading }
}
