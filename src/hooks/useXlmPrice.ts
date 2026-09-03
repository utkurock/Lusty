'use client'
import { useCallback, useEffect, useState } from 'react'

interface PriceData {
  price: number
  change24h: number
  loading: boolean
  error: string | null
  source: string
}

// Polled rather than streamed. The old hook held a Binance websocket open for a
// tick-by-tick price, which looked live and cost the page a third-party socket
// that a good share of networks refuse to open — and when it failed there was
// nothing behind it. Nothing on these screens is traded on a per-tick basis:
// strikes are quoted in tenors of days, so a price that moves every few seconds
// is as live as this app needs to be.
const POLL_MS = 10_000

export function useXlmPrice(): PriceData {
  const [data, setData] = useState<PriceData>({
    price: 0,
    change24h: 0,
    loading: true,
    error: null,
    source: 'none',
  })

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/price/xlm', { cache: 'no-store' })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.ok || typeof json.price !== 'number') {
        throw new Error(json?.error ?? `price unavailable (${res.status})`)
      }
      setData((prev) => ({
        price: json.price,
        // A change the server could not determine keeps the last one we had
        // rather than snapping to zero — "flat" is a claim, not a placeholder.
        change24h: typeof json.change24h === 'number' ? json.change24h : prev.change24h,
        loading: false,
        error: null,
        source: json.source ?? 'server',
      }))
    } catch (e: any) {
      // Keep the last good price on screen and say the feed is stale. The old
      // hook seeded 0.10 and left it there when Binance was unreachable, which
      // put a number nobody stood behind next to the word "XLM / USD".
      setData((prev) => ({
        ...prev,
        loading: false,
        error: e?.message ?? 'price unavailable',
      }))
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  return data
}
