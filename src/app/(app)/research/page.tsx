'use client'

import { useEffect, useState } from 'react'
import { TradingViewChart } from '@/components/research/TradingViewChart'
import { RefreshCw, ExternalLink, Sparkles, Loader2, TrendingUp, TrendingDown, Minus } from 'lucide-react'

interface Commentary {
  generatedAt: number
  price: number
  change24hPct: number
  bias: 'bullish' | 'bearish' | 'neutral'
  headline: string
  bullets: string[]
  suggestion: string
}

interface NewsItem {
  id: string
  title: string
  source: string
  url: string
  publishedAt: number
  imageUrl?: string
}

function BiasChip({ bias }: { bias: 'bullish' | 'bearish' | 'neutral' }) {
  const cfg =
    bias === 'bullish'
      ? { label: 'bullish', Icon: TrendingUp, color: 'text-[#22c55e] border-[#22c55e]/40 bg-[#22c55e]/10' }
      : bias === 'bearish'
      ? { label: 'bearish', Icon: TrendingDown, color: 'text-[#ef4444] border-[#ef4444]/40 bg-[#ef4444]/10' }
      : { label: 'neutral', Icon: Minus, color: 'text-[#6b6560] border-[#c4bfb2] bg-[#f0ece3]' }
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-sm border ${cfg.color}`}
    >
      <cfg.Icon size={10} />
      {cfg.label}
    </span>
  )
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  const m = Math.floor(diff / 60000)
  if (m < 1) return '< 1m ago'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function nextUpdateIn(generatedAtMs: number): string {
  const nextUpdate = generatedAtMs + 60 * 60 * 1000 // 1 hour after generation
  const diff = nextUpdate - Date.now()
  if (diff <= 0) return 'refreshing…'
  const m = Math.ceil(diff / 60000)
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`
  return `${m}m`
}

export default function ResearchPage() {
  // Live commentary + news
  const [commentary, setCommentary] = useState<Commentary | null>(null)
  const [commentaryLoading, setCommentaryLoading] = useState(false)
  const [news, setNews] = useState<NewsItem[] | null>(null)
  const [, setTick] = useState(0) // forces re-render every minute for timeAgo

  const loadCommentary = () => {
    setCommentaryLoading(true)
    fetch('/api/research/commentary')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setCommentary(d)
      })
      .catch(() => {})
      .finally(() => setCommentaryLoading(false))
  }
  const loadNews = () =>
    fetch('/api/research/news')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setNews(d.items)
      })
      .catch(() => {})

  useEffect(() => {
    loadCommentary()
    loadNews()
    // Refresh data every 2 minutes
    const dataId = setInterval(() => {
      loadCommentary()
      loadNews()
    }, 120_000)
    // Tick every 30s so timeAgo/nextUpdateIn stay fresh
    const tickId = setInterval(() => setTick((t) => t + 1), 30_000)
    return () => {
      clearInterval(dataId)
      clearInterval(tickId)
    }
  }, [])

  return (
    <main className="max-w-7xl mx-auto px-6 py-10 text-[#1a1a1a]">
      {/* Market panel: chart + AI commentary + news */}
      <section className="mb-12">
        <div className="flex items-baseline justify-between mb-4">
          <div>
            <div className="font-mono text-xs text-[#6b6560]">~/research</div>
            <h2 className="text-2xl font-bold text-[#1a1a1a] mt-1">
              XLM research desk
            </h2>
          </div>
          {commentary && (
            <div className="font-mono text-[11px] text-[#6b6560]">
              updated {timeAgo(commentary.generatedAt)} · next in {nextUpdateIn(commentary.generatedAt)}
            </div>
          )}
        </div>

        <div className="grid lg:grid-cols-3 gap-4">
          {/* Chart */}
          <div className="lg:col-span-2">
            <TradingViewChart />
          </div>

          {/* AI commentary */}
          <div className="light-card rounded-sm p-5 flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Sparkles size={14} className="text-[#eab308]" />
                <div className="font-mono text-[11px] uppercase text-[#6b6560] tracking-wider">
                  Desk note
                </div>
              </div>
              <button
                onClick={loadCommentary}
                disabled={commentaryLoading}
                className="text-[#6b6560] hover:text-[#1a1a1a] transition disabled:opacity-50"
                aria-label="Refresh commentary"
              >
                {commentaryLoading ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RefreshCw size={12} />
                )}
              </button>
            </div>

            {commentary ? (
              <>
                <div className="flex items-center gap-2 mb-1">
                  <BiasChip bias={commentary.bias} />
                  <span
                    className={`num text-xs font-bold ${
                      commentary.change24hPct >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'
                    }`}
                  >
                    ${commentary.price.toFixed(4)} ·{' '}
                    {commentary.change24hPct >= 0 ? '+' : ''}
                    {commentary.change24hPct.toFixed(2)}%
                  </span>
                </div>
                <h3 className="font-bold text-[#1a1a1a] text-[15px] mt-2 leading-snug">
                  {commentary.headline}
                </h3>
                <ul className="mt-3 space-y-1.5 text-xs text-[#3a3a3a] font-mono leading-relaxed">
                  {commentary.bullets.map((b, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-[#eab308]">›</span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-4 pt-3 border-t border-[#c4bfb2] border-dashed">
                  <div className="font-mono text-[10px] uppercase text-[#6b6560] tracking-wider mb-1">
                    Suggestion
                  </div>
                  <div className="text-xs text-[#1a1a1a] leading-relaxed">
                    {commentary.suggestion}
                  </div>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-xs text-[#6b6560] font-mono">
                {commentaryLoading ? 'loading…' : 'no data'}
              </div>
            )}
          </div>
        </div>

        {/* News feed */}
        <div className="mt-6">
          <div className="flex items-baseline justify-between mb-3">
            <div className="font-mono text-xs uppercase text-[#6b6560] tracking-wider">
              ~/news
            </div>
            <div className="font-mono text-[10px] text-[#6b6560]">
              Stellar / XLM / DeFi · auto-refresh 2m
            </div>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
            {news === null && (
              <div className="col-span-full font-mono text-xs text-[#6b6560] light-card rounded-sm p-5">
                Loading news…
              </div>
            )}
            {news && news.length === 0 && (
              <div className="col-span-full font-mono text-xs text-[#6b6560] light-card rounded-sm p-5">
                No news items right now.
              </div>
            )}
            {news?.slice(0, 9).map((n) => (
              <a
                key={n.id}
                href={n.url}
                target="_blank"
                rel="noopener noreferrer"
                className="light-card rounded-sm p-4 hover:bg-[#e8e4d9] transition group flex flex-col"
              >
                <div className="font-mono text-[10px] uppercase text-[#6b6560] tracking-wider mb-1 flex items-center justify-between">
                  <span className="truncate">{n.source}</span>
                  <span>{timeAgo(n.publishedAt)}</span>
                </div>
                <div className="text-[13px] leading-snug text-[#1a1a1a] group-hover:text-[#eab308] transition line-clamp-3">
                  {n.title}
                </div>
                <div className="mt-auto pt-2 flex items-center gap-1 text-[10px] font-mono text-[#6b6560]">
                  read
                  <ExternalLink size={10} />
                </div>
              </a>
            ))}
          </div>
        </div>
      </section>

    </main>
  )
}

