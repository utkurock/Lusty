'use client'
import { useEffect, useState } from 'react'
import { AssetRow } from './AssetRow'
import { cn } from '@/lib/utils'
import { useVaultStats } from '@/hooks/useVaultStats'
import { upcomingExpiryDates, MIN_DAYS_TO_EXPIRY } from '@/lib/expiries'

export type Tab = 'calls' | 'puts'

interface AssetListProps {
  tab: Tab
  onTabChange: (tab: Tab) => void
}

interface AprRange {
  max: number
  min: number
}

export function AssetList({ tab, onTabChange }: AssetListProps) {
  const { stats } = useVaultStats()

  // Real APR range from the quote engine (same engine that pays the premium),
  // not hardcoded. APR rises with tenor and with proximity to spot, so the full
  // offered range spans two corners:
  //   MAX = longest expiry, nearest strike   (highest yield on offer)
  //   MIN = shortest expiry, deepest OTM      (lowest/safest yield on offer)
  const [callApr, setCallApr] = useState<AprRange | undefined>()
  const [putApr, setPutApr] = useState<AprRange | undefined>()

  useEffect(() => {
    let cancelled = false
    const now = Date.now()
    const dates = upcomingExpiryDates()
    const daysTo = (d: Date) =>
      Math.max(MIN_DAYS_TO_EXPIRY, Math.ceil((d.getTime() - now) / 86_400_000))
    const shortDays = daysTo(dates[0])
    const longDays = daysTo(dates[dates.length - 1])

    const ladder = async (side: 'call' | 'put', days: number): Promise<number[] | undefined> => {
      try {
        const r = await fetch(`/api/vault/quote?side=${side}&days=${days}`)
        const j = await r.json()
        if (!j.ok || !Array.isArray(j.strikes) || j.strikes.length === 0) return undefined
        return j.strikes.map((s: { apr: number }) => s.apr)
      } catch {
        return undefined
      }
    }
    const range = async (side: 'call' | 'put'): Promise<AprRange | undefined> => {
      const [longL, shortL] = await Promise.all([ladder(side, longDays), ladder(side, shortDays)])
      if (!longL || !shortL) return undefined
      return { max: Math.max(...longL), min: Math.min(...shortL) }
    }
    Promise.all([range('call'), range('put')]).then(([c, p]) => {
      if (cancelled) return
      setCallApr(c)
      setPutApr(p)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Only block the entry point when every open expiry is full.
  const callsFull =
    !!stats &&
    stats.buckets.length > 0 &&
    stats.buckets.every((b) => b.callFull)
  const putsFull =
    !!stats &&
    stats.buckets.length > 0 &&
    stats.buckets.every((b) => b.putFull)

  return (
    <div className="terminal-card rounded-sm overflow-hidden">
      <div className="px-6 py-3 border-b border-line-2 flex items-center justify-between">
        <div className="font-mono text-sm text-cream">~/assets</div>
        <div className="flex gap-1">
          <button
            onClick={() => onTabChange('calls')}
            className={cn(
              'font-mono text-xs px-3 py-1 rounded-sm transition',
              tab === 'calls' ? 'bg-[#eab308] text-ink' : 'text-cream hover:bg-line-2'
            )}
          >
            covered calls
          </button>
          <button
            onClick={() => onTabChange('puts')}
            className={cn(
              'font-mono text-xs px-3 py-1 rounded-sm transition',
              tab === 'puts' ? 'bg-[#eab308] text-ink' : 'text-cream hover:bg-line-2'
            )}
          >
            cash secured puts
          </button>
        </div>
      </div>

      <div className="bg-card">
        <div className="hidden md:grid grid-cols-12 px-6 py-3 font-mono text-[11px] uppercase text-ink-2 dashed-row">
          <div className="col-span-4">Asset</div>
          <div className="col-span-3">Type</div>
          <div className="col-span-2">Max APR</div>
          <div className="col-span-1">Min APR</div>
          <div className="col-span-2 text-right">Action</div>
        </div>

        {tab === 'calls' ? (
          <AssetRow
            symbol="XLM"
            name="Stellar Lumens"
            type="Covered Call"
            maxAPR={callApr?.max}
            minAPR={callApr?.min}
            href="/earn/xlm"
            disabled={callsFull}
            disabledReason="Vault full"
          />
        ) : (
          <AssetRow
            symbol="XLM"
            name="Stellar Lumens"
            type="Cash Secured Put"
            maxAPR={putApr?.max}
            minAPR={putApr?.min}
            href="/earn/xlm?type=put"
            disabled={putsFull}
            disabledReason="Vault full"
          />
        )}
      </div>
    </div>
  )
}
