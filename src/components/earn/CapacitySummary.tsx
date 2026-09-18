'use client'
import { useEffect, useState } from 'react'
import type { UnderlyingAsset } from '@/lib/assets'

interface CapacitySummaryProps {
  books: UnderlyingAsset[]
  side: 'call' | 'put'
  /** How often to re-read, in ms. Matches the per-book poll. */
  intervalMs?: number
}

/** null percent means the book's figures could not be read, not that it is empty. */
interface BookUse {
  symbol: string
  pct: number | null
}

/**
 * How full each book is, one bar per book, under the heading.
 *
 * A percentage and not a quantity, because the books do not share a unit:
 * capacity is 1,500,000 lumens on one instance and 5 bitcoin on the other, and
 * the only way to add those is to price them, which puts a moving dollar figure
 * on a line that is trying to answer "is there room". Each book's own ratio
 * needs no price and cannot go stale.
 *
 * The bars used to be the expiries of one book, repeated under every row. That
 * is a choice made on the strike screen, not while reading a list — so the same
 * graphic now splits by the thing this screen is actually about. The number in
 * each bar is the one the asset's own page shows in its ring, so the list and
 * the page agree.
 */
export function CapacitySummary({ books, side, intervalMs = 30_000 }: CapacitySummaryProps) {
  const [uses, setUses] = useState<BookUse[]>([])

  // The symbols, not the objects: the registry hands back a fresh array each
  // render and an object identity would re-run this every time.
  const symbols = books.map((b) => b.symbol).join(',')

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      const list = symbols ? symbols.split(',') : []
      if (list.length === 0) {
        if (!cancelled) setUses([])
        return
      }

      const next = await Promise.all(
        list.map(async (symbol): Promise<BookUse> => {
          try {
            const res = await fetch(`/api/vault/stats?asset=${symbol}`, {
              cache: 'no-store',
            })
            const d = await res.json()
            if (!d?.ok) return { symbol, pct: null }
            const s = side === 'call' ? d.call : d.put
            const used = Number(side === 'call' ? s?.utilizedXlm : s?.utilizedUsd)
            const cap = Number(side === 'call' ? s?.capXlm : s?.capUsd)
            if (!isFinite(used) || !isFinite(cap) || cap <= 0) {
              return { symbol, pct: null }
            }
            return { symbol, pct: (used / cap) * 100 }
          } catch {
            return { symbol, pct: null }
          }
        }),
      )

      if (!cancelled) setUses(next)
    }

    load()
    const id = setInterval(load, intervalMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [symbols, side, intervalMs])

  if (uses.length === 0) return null

  return (
    <div className="w-full">
      <div className="label mb-2">Capacity</div>

      {/* Bars sit in a sunken well rather than on a bordered plate: the track is
          the surface below the card, so the fill reads as depth, not paint. */}
      <div className="flex gap-2">
        {uses.map((u) => {
          const full = u.pct !== null && u.pct >= 100
          const width = u.pct === null ? 0 : Math.min(100, Math.max(0, u.pct))
          return (
            <div
              key={u.symbol}
              className="relative flex-1 h-10 rounded-sm overflow-hidden bg-surface-2"
              role="progressbar"
              aria-valuenow={u.pct === null ? undefined : Math.round(u.pct)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${u.symbol} capacity used`}
            >
              <div
                className={`absolute inset-y-0 left-0 animate-fill transition-all duration-700 ease-std ${full ? 'bg-accent-red/85' : 'bg-accent-green/85'}`}
                style={{ width: `${width}%` }}
              />
              <div className="absolute inset-0 flex items-center justify-center gap-2 font-mono">
                <span className="text-micro uppercase tracking-[0.08em] text-ink font-semibold">
                  {u.symbol}
                </span>
                <span className="num text-micro text-ink-2">
                  {u.pct === null ? '—' : full ? 'FULL' : `${u.pct.toFixed(1)}% used`}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
