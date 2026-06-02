'use client'
import { AssetRow } from './AssetRow'
import { cn } from '@/lib/utils'
import { useVaultStats } from '@/hooks/useVaultStats'

export type Tab = 'calls' | 'puts'

interface AssetListProps {
  tab: Tab
  onTabChange: (tab: Tab) => void
}

export function AssetList({ tab, onTabChange }: AssetListProps) {
  const { stats } = useVaultStats()
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
            maxAPR={113.4}
            minAPR={24.1}
            href="/earn/xlm"
            disabled={callsFull}
            disabledReason="Vault full"
          />
        ) : (
          <AssetRow
            symbol="XLM"
            name="Stellar Lumens"
            type="Cash Secured Put"
            maxAPR={96.8}
            minAPR={18.7}
            href="/earn/xlm?type=put"
            disabled={putsFull}
            disabledReason="Vault full"
          />
        )}
      </div>
    </div>
  )
}
