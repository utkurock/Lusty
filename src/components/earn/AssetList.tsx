'use client'
import { useState } from 'react'
import { AssetRow } from './AssetRow'
import { cn } from '@/lib/utils'

type Tab = 'calls' | 'puts'

export function AssetList() {
  const [tab, setTab] = useState<Tab>('calls')

  return (
    <div className="terminal-card rounded-sm overflow-hidden">
      <div className="px-6 py-3 border-b border-[#2a2a2a] flex items-center justify-between">
        <div className="font-mono text-sm text-[#e8e4d9]">~/assets</div>
        <div className="flex gap-1">
          <button
            onClick={() => setTab('calls')}
            className={cn(
              'font-mono text-xs px-3 py-1 rounded-sm transition',
              tab === 'calls' ? 'bg-[#eab308] text-[#1a1a1a]' : 'text-[#e8e4d9] hover:bg-[#2a2a2a]'
            )}
          >
            covered calls
          </button>
          <button
            onClick={() => setTab('puts')}
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
          />
        ) : (
          <AssetRow
            symbol="XLM"
            name="Stellar Lumens"
            type="Cash Secured Put"
            maxAPR={96.8}
            minAPR={18.7}
            href="/earn/xlm?type=put"
          />
        )}
      </div>
    </div>
  )
}
