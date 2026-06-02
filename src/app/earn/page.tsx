'use client'
import { useState } from 'react'
import { useXlmPrice } from '@/hooks/useXlmPrice'
import { useVaultStats } from '@/hooks/useVaultStats'
import { EpochCapProgress } from '@/components/earn/EpochCapProgress'
import { AssetList, type Tab } from '@/components/earn/AssetList'
import { formatUsdc } from '@/lib/utils'
import { TrendingUp, TrendingDown } from 'lucide-react'

export default function EarnPage() {
  const { price, change24h, loading } = useXlmPrice()
  const { stats: vaultStats } = useVaultStats(30_000)
  const [tab, setTab] = useState<Tab>('calls')

  const positive = change24h >= 0
  // Each side has its own independent capacity; show the bar that matches the
  // active tab (call → XLM cap, put → USD cap).
  const isCalls = tab === 'calls'
  const side = isCalls ? vaultStats?.call : vaultStats?.put
  // Map each open expiry bucket to this side's numbers for the timeline.
  const segments = (vaultStats?.buckets ?? []).map((b) =>
    isCalls
      ? { label: b.label, utilized: b.callXlm, cap: b.callCapXlm, full: b.callFull }
      : { label: b.label, utilized: b.putUsd, cap: b.putCapUsd, full: b.putFull }
  )

  return (
    <div className="max-w-7xl mx-auto px-6 py-10 space-y-10">
      <section
        className="terminal-card rounded-sm p-10 md:p-14 relative overflow-hidden bg-inverse"
      >
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: 'url(/hero-dither.png)',
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            opacity: 0.35,
            mixBlendMode: 'screen',
          }}
        />
        <div className="absolute inset-0 pointer-events-none bg-gradient-to-r from-inverse via-inverse/70 to-transparent" />
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6 relative">
          <div className="max-w-2xl">
            <div className="font-mono text-xs text-[#eab308] mb-3">~/lusty</div>
            <h1 className="text-4xl md:text-6xl font-bold text-cream leading-tight">
              Earn yield<br />upfront.
            </h1>
            <p className="mt-4 font-mono text-sm text-cream/70 max-w-md">
              Choose an asset. Pick your strike. Receive upfront now.
            </p>
          </div>

          <div className="text-right">
            <div className="font-mono text-[11px] uppercase text-cream/50">XLM / USD</div>
            <div className="num text-3xl font-bold text-cream">
              {loading ? '—' : formatUsdc(price)}
            </div>
            <div className={`num text-sm mt-1 flex items-center gap-1 justify-end ${positive ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
              {positive ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
              {change24h.toFixed(2)}% 24h
            </div>
          </div>
        </div>
      </section>

      {side && vaultStats && (
        <section>
          <EpochCapProgress
            utilized={side.utilized}
            cap={side.cap}
            unit={isCalls ? 'XLM' : 'USD'}
            label={isCalls ? 'covered calls' : 'cash secured puts'}
            segments={segments}
          />
        </section>
      )}

      <section>
        <AssetList tab={tab} onTabChange={setTab} />
      </section>
    </div>
  )
}
