'use client'
import { useEffect, useState } from 'react'
import { AssetRow } from './AssetRow'
import { cn } from '@/lib/utils'
import { useVaultStats } from '@/hooks/useVaultStats'
import { upcomingExpiryDates } from '@/lib/expiries'
import { fetchLadder } from '@/lib/quote-client'

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
    // Quote by expiry, so the range advertised here is priced against the same
    // tenor AND the same pool utilization the earn screen and the co-signature
    // use. Asking by `days` alone quoted an empty pool, which overstated the
    // headline as the vault filled up.
    const dates = upcomingExpiryDates()
    const shortExpiry = dates[0].toISOString()
    const longExpiry = dates[dates.length - 1].toISOString()

    const ladder = async (side: 'call' | 'put', expiry: string): Promise<number[] | undefined> => {
      try {
        const aprs = (await fetchLadder(side, expiry)).strikes.map((s) => s.apr)
        return aprs.length > 0 ? aprs : undefined
      } catch {
        return undefined
      }
    }
    const range = async (side: 'call' | 'put'): Promise<AprRange | undefined> => {
      const [longL, shortL] = await Promise.all([ladder(side, longExpiry), ladder(side, shortExpiry)])
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
