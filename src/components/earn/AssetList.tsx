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
  // Each side has its own per-epoch cap (call in XLM, put in USD). Block the
  // matching entry point when its vault is at/over cap so a user can't reach
  // the strike selector, sign a deposit, lock collateral on-chain, and only
  // then hit the server's 409 cap rejection (BUG-2). The metric is the
  // current-epoch flow (resets each epoch), so "full" is real, not noise.
  const callsFull =
    !!stats && stats.call.cap > 0 && stats.call.utilized >= stats.call.cap
  const putsFull =
    !!stats && stats.put.cap > 0 && stats.put.utilized >= stats.put.cap

  return (
    <div className="terminal-card rounded-sm overflow-hidden">
      <div className="px-6 py-3 border-b border-[#2a2a2a] flex items-center justify-between">
        <div className="font-mono text-sm text-[#e8e4d9]">~/assets</div>
        <div className="flex gap-1">
          <button
            onClick={() => onTabChange('calls')}
            className={cn(
              'font-mono text-xs px-3 py-1 rounded-sm transition',
              tab === 'calls' ? 'bg-[#eab308] text-[#1a1a1a]' : 'text-[#e8e4d9] hover:bg-[#2a2a2a]'
            )}
          >
            covered calls
          </button>
          <button
            onClick={() => onTabChange('puts')}
            className={cn(
              'font-mono text-xs px-3 py-1 rounded-sm transition',
              tab === 'puts' ? 'bg-[#eab308] text-[#1a1a1a]' : 'text-[#e8e4d9] hover:bg-[#2a2a2a]'
            )}
          >
            cash secured puts
          </button>
        </div>
      </div>

      <div className="bg-[#f0ece3]">
        <div className="hidden md:grid grid-cols-12 px-6 py-3 font-mono text-[11px] uppercase text-[#6b6560] dashed-row">
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
