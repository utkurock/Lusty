'use client'
import { useXlmPrice } from '@/hooks/useXlmPrice'
import { useVaultStats } from '@/hooks/useVaultStats'
import { CapProgress } from '@/components/earn/CapProgress'
import { AssetList } from '@/components/earn/AssetList'
import { formatUsdc } from '@/lib/utils'
import { TrendingUp, TrendingDown } from 'lucide-react'

export default function EarnPage() {
  const { price, change24h, loading } = useXlmPrice()
  const { stats: vaultStats } = useVaultStats(30_000)

  const positive = change24h >= 0

  return (
    <div className="max-w-7xl mx-auto px-6 py-10 space-y-10">
      <section
        className="terminal-card rounded-sm p-10 md:p-14 relative overflow-hidden bg-[#1a1a1a]"
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
        <div className="absolute inset-0 pointer-events-none bg-gradient-to-r from-[#1a1a1a] via-[#1a1a1a]/70 to-transparent" />
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6 relative">
          <div className="max-w-2xl">
            <div className="font-mono text-xs text-[#eab308] mb-3">~/lusty</div>
            <h1 className="text-4xl md:text-6xl font-bold text-[#e8e4d9] leading-tight">
              Earn yield<br />upfront.
            </h1>
            <p className="mt-4 font-mono text-sm text-[#e8e4d9]/70 max-w-md">
              Choose an asset. Pick your strike. Receive upfront now.
            </p>
          </div>

          <div className="text-right">
            <div className="font-mono text-[11px] uppercase text-[#e8e4d9]/50">XLM / USD</div>
            <div className="num text-3xl font-bold text-[#e8e4d9]">
              {loading ? '—' : formatUsdc(price)}
            </div>
            <div className={`num text-sm mt-1 flex items-center gap-1 justify-end ${positive ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
              {positive ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
              {change24h.toFixed(2)}% 24h
            </div>
          </div>
        </div>
      </section>

      {vaultStats && (
        <section>
          <div className="font-mono text-xs uppercase text-[#6b6560] mb-2">Current epoch utilization</div>
          <CapProgress utilized={vaultStats.utilizedXlm} cap={vaultStats.capXlm} />
        </section>
      )}

      <section>
        <AssetList />
      </section>
    </div>
  )
}
