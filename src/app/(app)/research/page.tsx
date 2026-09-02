'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { TradingViewChart } from '@/components/research/TradingViewChart'
import { PageHeader } from '@/components/shared/PageHeader'
import { Panel } from '@/components/shared/Panel'
import { EmptyState } from '@/components/shared/EmptyState'
import {
  RefreshCw,
  ExternalLink,
  Loader2,
  TrendingUp,
  TrendingDown,
  Minus,
  Newspaper,
  ArrowRight,
} from 'lucide-react'

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
      ? { label: 'bullish', Icon: TrendingUp, color: 'text-accent-green border-accent-green/40 bg-accent-green/10' }
      : bias === 'bearish'
      ? { label: 'bearish', Icon: TrendingDown, color: 'text-accent-red border-accent-red/40 bg-accent-red/10' }
      : { label: 'neutral', Icon: Minus, color: 'text-ink-2 border-line bg-card' }
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-micro uppercase tracking-wider px-2 py-0.5 rounded-sm border ${cfg.color}`}
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
    <main className="max-w-content mx-auto px-6 py-10 text-ink">
      {/* Same header, panels and empty state as the dashboard and leaderboard.
          The desk is a page of this app, not a widget board bolted onto it. */}
      <PageHeader
        path="~/research"
        title="XLM research desk"
        subtitle="The live tape, an hourly note on what it means for premium sellers, and the Stellar headlines behind it."
        action={
          <Link href="/earn" className="btn btn-primary press">
            Earn upfront
            <ArrowRight size={14} />
          </Link>
        }
      />

      {/* The two panels are one row, so they end on the same line: the grid
          stretches them and the note's disclaimer is pushed to the foot rather
          than leaving a short card beside a tall chart. */}
      <div className="grid lg:grid-cols-3 gap-4">
        <Panel
          className="lg:col-span-2 min-w-0"
          title="XLM / USDT · 1h"
          note="Binance spot · TradingView"
        >
          <TradingViewChart />
        </Panel>

        <Panel
          className="flex flex-col"
          title="Desk note"
          action={
            <div className="flex items-center gap-3">
              {commentary && (
                <span className="font-mono text-tiny text-ink-2">
                  {timeAgo(commentary.generatedAt)} · next in{' '}
                  {nextUpdateIn(commentary.generatedAt)}
                </span>
              )}
              <button
                onClick={loadCommentary}
                disabled={commentaryLoading}
                className="press text-ink-2 hover:text-ink transition disabled:opacity-50"
                aria-label="Refresh commentary"
              >
                {commentaryLoading ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RefreshCw size={12} />
                )}
              </button>
            </div>
          }
        >
          {commentary ? (
            <>
              <div className="flex items-center gap-2">
                <BiasChip bias={commentary.bias} />
                <span
                  className={`num text-caption font-bold ${
                    commentary.change24hPct >= 0 ? 'text-accent-green' : 'text-accent-red'
                  }`}
                >
                  ${commentary.price.toFixed(4)} ·{' '}
                  {commentary.change24hPct >= 0 ? '+' : ''}
                  {commentary.change24hPct.toFixed(2)}%
                </span>
              </div>
              <h3 className="font-display text-ink text-lead mt-3 leading-snug">
                {commentary.headline}
              </h3>
              <ul className="mt-3 space-y-1.5 text-caption text-ink-3 font-mono leading-relaxed">
                {commentary.bullets.map((b, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-brand">›</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-4 pt-3 border-t border-line border-dashed">
                <div className="label mb-1">Suggestion</div>
                <div className="text-caption text-ink leading-relaxed">
                  {commentary.suggestion}
                </div>
              </div>
              {/* A desk note is a reading of the tape, not advice about your
                  book. Say so where it is read, not in a footer nobody scrolls
                  to. */}
              <div className="font-mono text-tiny text-ink-faint mt-auto pt-6">
                Generated from live market data. Not financial advice.
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center font-mono text-caption text-ink-2 py-6">
              {commentaryLoading ? 'loading…' : 'No desk note right now.'}
            </div>
          )}
        </Panel>
      </div>

      <Panel
        className="mt-8"
        title="~/news"
        note="Stellar / XLM / DeFi · auto-refresh 2m"
      >
        {news === null ? (
          <div className="font-mono text-caption text-ink-2 py-6 text-center">
            Loading news…
          </div>
        ) : news.length === 0 ? (
          <EmptyState
            icon={Newspaper}
            title="No headlines right now."
            hint="The feed is polled every two minutes; anything new lands here on its own."
          />
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
            {news.slice(0, 9).map((n) => (
              <a
                key={n.id}
                href={n.url}
                target="_blank"
                rel="noopener noreferrer"
                className="light-card card-interactive p-4 group flex flex-col"
              >
                <div className="label mb-1 flex items-center justify-between gap-2">
                  <span className="truncate">{n.source}</span>
                  <span className="shrink-0">{timeAgo(n.publishedAt)}</span>
                </div>
                <div className="text-caption leading-snug text-ink group-hover:text-brand transition line-clamp-3">
                  {n.title}
                </div>
                <div className="mt-auto pt-2 flex items-center gap-1 text-micro font-mono text-ink-2">
                  read
                  <ExternalLink size={10} />
                </div>
              </a>
            ))}
          </div>
        )}
      </Panel>
    </main>
  )
}
