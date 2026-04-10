'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { useWalletContext } from '@/providers/WalletProvider'
import { formatAddress } from '@/lib/utils'
import { Trophy, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'

interface LeaderRow {
  rank: number
  address: string
  points: number
  totalDeposited: number
  totalPremium: number
  depositCount: number
}

function Rank({ rank }: { rank: number }) {
  const medalColor =
    rank === 1
      ? 'bg-[#eab308] text-[#1a1a1a]'
      : rank === 2
      ? 'bg-[#c4bfb2] text-[#1a1a1a]'
      : rank === 3
      ? 'bg-[#b4844b] text-[#1a1a1a]'
      : 'bg-transparent text-[#6b6560]'
  return (
    <div
      className={`font-mono text-sm w-8 h-8 flex items-center justify-center rounded-sm ${medalColor}`}
    >
      {rank <= 3 ? <Trophy size={14} /> : rank}
    </div>
  )
}

type SortKey = 'rank' | 'points' | 'totalDeposited' | 'totalPremium'

export default function LeaderboardPage() {
  const { connected, address } = useWalletContext()
  const [sortKey, setSortKey] = useState<SortKey>('rank')
  const PAGE_SIZE = 10
  const [page, setPage] = useState(0)
  const [rows, setRows] = useState<LeaderRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [yourRow, setYourRow] = useState<LeaderRow | null>(null)

  const fetchLeaderboard = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/leaderboard?limit=200`)
      const data = await res.json()
      if (data.ok) {
        setRows(data.rows)
        setTotal(data.total)
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  // Polling cadence: 2 minutes is enough to feel "live" while cutting
  // server load 8× compared to the previous 15s. Users who want immediate
  // feedback get it via the optimistic local update + the explicit refresh
  // triggered after their own deposit completes (see lustyLeaderboardRefresh).
  const POLL_INTERVAL_MS = 120_000

  useEffect(() => {
    // Hydrate from localStorage cache so the table isn't blank on first paint.
    try {
      const cached = localStorage.getItem('lusty_leaderboard_cache')
      if (cached) {
        const parsed = JSON.parse(cached)
        if (Array.isArray(parsed.rows)) {
          setRows(parsed.rows)
          setTotal(parsed.total ?? parsed.rows.length)
          setLoading(false)
        }
      }
    } catch {
      /* ignore corrupted cache */
    }

    fetchLeaderboard()
    const id = setInterval(fetchLeaderboard, POLL_INTERVAL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchLeaderboard()
    }
    // External event so deposit/swap flows can trigger an immediate refresh
    // (dispatched from StrikeSelector / SwapPanel after a successful tx).
    const onExternalRefresh = () => fetchLeaderboard()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('lustyLeaderboardRefresh', onExternalRefresh)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('lustyLeaderboardRefresh', onExternalRefresh)
    }
  }, [fetchLeaderboard])

  // Persist successful fetches so the next visit hydrates instantly.
  useEffect(() => {
    if (rows.length > 0) {
      try {
        localStorage.setItem(
          'lusty_leaderboard_cache',
          JSON.stringify({ rows, total, savedAt: Date.now() })
        )
      } catch {
        /* quota exceeded — fine to ignore */
      }
    }
  }, [rows, total])

  // Fetch user's own stats — also polled at the same cadence.
  const fetchYou = useCallback(() => {
    if (!connected || !address) {
      setYourRow(null)
      return
    }
    fetch(`/api/leaderboard?address=${address}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.ok && data.user) {
          setYourRow(data.user)
        } else {
          setYourRow(null)
        }
      })
      .catch(() => setYourRow(null))
  }, [connected, address])

  useEffect(() => {
    fetchYou()
    if (!connected || !address) return
    const id = setInterval(fetchYou, POLL_INTERVAL_MS)
    const onExternalRefresh = () => fetchYou()
    window.addEventListener('lustyLeaderboardRefresh', onExternalRefresh)
    return () => {
      clearInterval(id)
      window.removeEventListener('lustyLeaderboardRefresh', onExternalRefresh)
    }
  }, [fetchYou, connected, address])

  const sorted = useMemo(() => {
    const copy = [...rows]
    copy.sort((a, b) => {
      if (sortKey === 'rank') return a.rank - b.rank
      return (b[sortKey] as number) - (a[sortKey] as number)
    })
    return copy
  }, [sortKey, rows])

  const totalPoints = rows.reduce((sum, r) => sum + r.points, 0)
  const totalDeposits = rows.reduce((sum, r) => sum + r.totalDeposited, 0)
  const totalPremium = rows.reduce((sum, r) => sum + r.totalPremium, 0)

  const SortButton = ({ k, children }: { k: SortKey; children: React.ReactNode }) => (
    <button
      onClick={() => setSortKey(k)}
      className={
        'font-mono text-[11px] uppercase tracking-wider transition ' +
        (sortKey === k ? 'text-[#1a1a1a]' : 'text-[#6b6560] hover:text-[#1a1a1a]')
      }
    >
      {children}
    </button>
  )

  return (
    <div className="max-w-7xl mx-auto px-6 pt-10 pb-2 space-y-10">
      {/* Hero */}
      <section className="terminal-card rounded-sm p-8 md:p-12 relative overflow-hidden">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: 'url(/leaderboard-dither.png)',
            backgroundSize: '140% auto',
            backgroundPosition: '50% center',
            backgroundRepeat: 'no-repeat',
            opacity: 0.5,
            mixBlendMode: 'screen',
          }}
        />
        <div className="absolute inset-0 pointer-events-none bg-gradient-to-r from-[#1a1a1a] via-[#1a1a1a]/80 to-transparent" />
        <div className="relative flex flex-col md:flex-row md:items-end md:justify-between gap-6">
          <div>
            <div className="font-mono text-xs text-[#eab308] mb-3">~/leaderboard</div>
            <h1 className="text-4xl md:text-5xl font-bold text-[#e8e4d9] leading-tight">
              Season 0 <span className="text-[#eab308]">points</span>
            </h1>
            <p className="mt-3 font-mono text-sm text-[#e8e4d9]/70 max-w-md">
              Every deposit and every USDC upfront you earn feeds a single
              leaderboard.
            </p>
            <a
              href="/docs"
              className="mt-4 inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider px-3 py-1.5 rounded-sm border border-[#eab308]/40 bg-[#eab308]/10 text-[#eab308] hover:bg-[#eab308]/20 transition"
            >
              How points work
              <span aria-hidden>→</span>
            </a>
          </div>
          <div className="grid grid-cols-3 gap-4 text-right font-mono">
            <div>
              <div className="text-[11px] uppercase text-[#e8e4d9]/50">Wallets</div>
              <div className="num text-xl font-bold text-[#e8e4d9]">
                {total.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase text-[#e8e4d9]/50">Points</div>
              <div className="num text-xl font-bold text-[#eab308]">
                {totalPoints >= 1000 ? `${(totalPoints / 1000).toFixed(1)}k` : totalPoints.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase text-[#e8e4d9]/50">Upfront</div>
              <div className="num text-xl font-bold text-[#22c55e]">
                ${totalPremium >= 1000 ? `${(totalPremium / 1000).toFixed(1)}k` : totalPremium.toFixed(2)}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Leaderboard table */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-mono text-xs uppercase text-[#6b6560] tracking-wider">
            ~/rankings
          </h2>
          <div className="font-mono text-[11px] text-[#6b6560]">
            sort by: <SortButton k="rank">rank</SortButton>{' '}
            · <SortButton k="points">points</SortButton>{' '}
            · <SortButton k="totalDeposited">volume</SortButton>{' '}
            · <SortButton k="totalPremium">upfront</SortButton>
          </div>
        </div>

        <div className="light-card rounded-sm overflow-x-auto">
          <div className="min-w-[600px]">
          <div className="grid grid-cols-[56px_1fr_120px_140px_140px] px-5 py-3 border-b border-[#c4bfb2] font-mono text-[11px] uppercase tracking-wider text-[#6b6560]">
            <div>#</div>
            <div>wallet</div>
            <div className="text-right">points</div>
            <div className="text-right">volume</div>
            <div className="text-right">upfront</div>
          </div>

          {/* Pinned "you" row above #1 */}
          {yourRow && (
            <div className="grid grid-cols-[56px_1fr_120px_140px_140px] items-center px-5 py-3 bg-[#eab308]/15 border-b-2 border-[#eab308] border-dashed">
              <div className="font-mono text-xs text-[#eab308] font-bold">YOU</div>
              <div className="font-mono text-xs text-[#1a1a1a] truncate flex items-center gap-2">
                <span className="num text-[#6b6560]">#{yourRow.rank}</span>
                <span className="font-semibold">{formatAddress(yourRow.address)}</span>
              </div>
              <div className="text-right num text-sm text-[#1a1a1a] font-bold">
                {yourRow.points.toLocaleString()}
              </div>
              <div className="text-right num text-xs text-[#6b6560]">
                ${yourRow.totalDeposited.toLocaleString()}
              </div>
              <div className="text-right num text-xs text-[#22c55e]">
                ${yourRow.totalPremium.toLocaleString()}
              </div>
            </div>
          )}

          {loading && (
            <div className="px-5 py-16 flex items-center justify-center">
              <Loader2 size={20} className="animate-spin text-[#6b6560]" />
            </div>
          )}

          {!loading && sorted.length === 0 && (
            <div className="px-5 py-16 text-center font-mono text-xs text-[#6b6560]">
              <div className="text-[#1a1a1a] font-semibold mb-1">
                No participants yet
              </div>
              Be the first to deposit. Every covered call and every cash
              secured put earns points the moment the upfront lands.
            </div>
          )}
          {!loading && sorted.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE).map((row) => (
            <div
              key={row.address}
              className="grid grid-cols-[56px_1fr_120px_140px_140px] items-center px-5 py-3 dashed-row hover:bg-[#e8e4d9] transition"
            >
              <Rank rank={row.rank} />
              <div className="font-mono text-xs text-[#1a1a1a] truncate">
                {formatAddress(row.address)}
              </div>
              <div className="text-right num text-sm text-[#1a1a1a] font-semibold">
                {row.points.toLocaleString()}
              </div>
              <div className="text-right num text-xs text-[#6b6560]">
                ${row.totalDeposited.toLocaleString()}
              </div>
              <div className="text-right num text-xs text-[#22c55e]">
                ${row.totalPremium.toLocaleString()}
              </div>
            </div>
          ))}

          </div>
        </div>

        {/* Horizontal pagination */}
        {sorted.length > 0 && (
        <div className="mt-3 flex items-center justify-between font-mono text-[11px] text-[#6b6560]">
          <div>
            total deposits ${(totalDeposits / 1_000_000).toFixed(2)}M
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="w-8 h-8 flex items-center justify-center rounded-sm border border-[#c4bfb2] bg-[#f0ece3] text-[#1a1a1a] hover:bg-[#e8e4d9] disabled:opacity-30 disabled:cursor-not-allowed transition"
              aria-label="Previous page"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="num">
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, sorted.length)} of {sorted.length}
            </span>
            <button
              onClick={() =>
                setPage((p) =>
                  Math.min(Math.ceil(sorted.length / PAGE_SIZE) - 1, p + 1)
                )
              }
              disabled={(page + 1) * PAGE_SIZE >= sorted.length}
              className="w-8 h-8 flex items-center justify-center rounded-sm border border-[#c4bfb2] bg-[#f0ece3] text-[#1a1a1a] hover:bg-[#e8e4d9] disabled:opacity-30 disabled:cursor-not-allowed transition"
              aria-label="Next page"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
        )}
      </section>

    </div>
  )
}
