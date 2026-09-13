'use client'
import { useState } from 'react'
import { useXlmPrice } from '@/hooks/useSpotPrice'
import { AssetList, type Tab } from '@/components/earn/AssetList'
import { formatUsdc } from '@/lib/utils'
import { TrendingUp, TrendingDown } from 'lucide-react'

export default function EarnPage() {
  const { price, change24h, loading } = useXlmPrice()
  const [tab, setTab] = useState<Tab>('calls')

  const positive = change24h >= 0

  return (
    <div className="page-glow max-w-content mx-auto px-6 py-10 space-y-8">
      <section
        className="terminal-card p-10 md:p-14 relative overflow-hidden bg-inverse shadow-table animate-rise"
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
            <div className="font-mono text-caption text-brand mb-3">~/lusty</div>
            <h1 className="font-display text-hero md:text-hero-lg text-cream">
              Earn yield<br />upfront.
            </h1>
            <p className="mt-5 font-mono text-body text-cream/70 max-w-md">
              Choose an asset. Pick your strike. Receive upfront now.
            </p>
          </div>

          <div className="text-right">
            <div className="label text-cream/50">XLM / USD</div>
            <div className="num text-head-lg font-bold text-cream mt-1">
              {loading ? '—' : formatUsdc(price)}
            </div>
            <div className={`num text-body mt-1 flex items-center gap-1 justify-end ${positive ? 'text-accent-green' : 'text-accent-red'}`}>
              {positive ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
              {change24h.toFixed(2)}% 24h
            </div>
          </div>
        </div>
      </section>

      {/* Capacity moved into the list, one bar per book: with two instances
          there is no such thing as "the vault's" remaining capacity, and a
          single bar above the list would describe whichever one it read. */}
      <section>
        <AssetList tab={tab} onTabChange={setTab} />
      </section>
    </div>
  )
}
