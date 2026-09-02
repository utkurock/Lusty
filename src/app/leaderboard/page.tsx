'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { useWalletContext } from '@/providers/WalletProvider'
import { formatAddress } from '@/lib/utils'
import { Trophy, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { EmptyState } from '@/components/shared/EmptyState'

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
      ? 'bg-brand text-ink'
      : rank === 2
      ? 'bg-line text-ink'
      : rank === 3
      ? 'bg-[#b4844b] text-ink'
      : 'bg-transparent text-ink-2'
  return (
    <div
      className={`font-mono text-body w-8 h-8 flex items-center justify-center rounded-sm ${medalColor}`}
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
  // A board that could not be read is not an empty board. Swallowing the
  // failure and leaving `rows` empty rendered "No participants yet." over 217
  // wallets — and only on devices with no cached copy to fall back on, which is
  // why it looked like a device problem.
  const [loadError, setLoadError] = useState<string | null>(null)

  const fetchLeaderboard = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/leaderboard?limit=200`)
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.ok || !Array.isArray(data.rows)) {
        throw new Error(data?.error ?? `leaderboard unavailable (${res.status})`)
      }
      setRows(data.rows)
      setTotal(data.total)
      setLoadError(null)
    } catch (e: any) {
      setLoadError(e?.message ?? 'could not reach the leaderboard')
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

  /* Sorting is a segmented control rather than four underlined words: the
     current sort is a state of the table, and a chip that stays lit says so
     better than a colour change on a link. */
  const SortButton = ({ k, children }: { k: SortKey; children: React.ReactNode }) => (
    <button
      onClick={() => setSortKey(k)}
      aria-selected={sortKey === k}
      role="tab"
      className="press press-sm"
    >
      {children}
    </button>
  )

  return (
    <div className="max-w-content mx-auto px-6 pt-10 pb-2 space-y-10">
      {/* Hero */}
      <section className="terminal-card rounded-sm p-8 md:p-12 relative overflow-hidden">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: 'url(/leaderboard-dither.png)',
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            opacity: 0.5,
            mixBlendMode: 'screen',
          }}
        />
        <div className="absolute inset-0 pointer-events-none bg-gradient-to-r from-inverse via-inverse/80 to-transparent" />
        <div className="relative flex flex-col md:flex-row md:items-end md:justify-between gap-6">
          <div>
            <div className="font-mono text-caption text-brand mb-3">~/leaderboard</div>
            <h1 className="font-display text-head-lg md:text-hero text-cream leading-tight">
              Season 0 <span className="text-brand">points</span>
            </h1>
            <p className="mt-3 font-mono text-body text-cream/70 max-w-md">
              Every deposit and every LUSD upfront you earn feeds a single
              leaderboard.
            </p>
            <a
              href="/docs#points"
              className="mt-4 inline-flex items-center gap-2 font-mono text-tiny uppercase tracking-wider px-3 py-1.5 rounded-sm border border-brand/40 bg-brand/10 text-brand hover:bg-brand/20 transition"
            >
              How points work
              <span aria-hidden>→</span>
            </a>
          </div>
          <div className="grid grid-cols-3 gap-4 text-right font-mono">
            <div>
              <div className="text-tiny uppercase text-cream/50">Wallets</div>
              <div className="num text-xl font-bold text-cream">
                {total.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-tiny uppercase text-cream/50">Points</div>
              <div className="num text-xl font-bold text-brand">
                {totalPoints >= 1000 ? `${(totalPoints / 1000).toFixed(1)}k` : totalPoints.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-tiny uppercase text-cream/50">Upfront</div>
              <div className="num text-xl font-bold text-accent-green">
                ${totalPremium >= 1000 ? `${(totalPremium / 1000).toFixed(1)}k` : totalPremium.toFixed(2)}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* No standing panel above the board: the pinned YOU row already carries
          the same rank, points, volume and upfront, in the columns the rest of
          the table is read in. Printing them twice made the board start halfway
          down the page. */}

      {/* Leaderboard table */}
      <section>
        <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
          <h2 className="label">
            ~/rankings
          </h2>
          <div role="tablist" className="segmented">
            <SortButton k="rank">rank</SortButton>
            <SortButton k="points">points</SortButton>
            <SortButton k="totalDeposited">volume</SortButton>
            <SortButton k="totalPremium">upfront</SortButton>
          </div>
        </div>

        <div className="scroll-slim overflow-x-auto">
          <div className="min-w-[600px] space-y-2">
          <div className="label grid grid-cols-[56px_1fr_120px_140px_140px] px-5">
            <div>#</div>
            <div>wallet</div>
            <div className="text-right">points</div>
            <div className="text-right">volume</div>
            <div className="text-right">upfront</div>
          </div>

          {/* The pinned row is for when your own row is somewhere you cannot see
              it. Once it is on the page in front of you — highlighted, in rank
              order — pinning a second copy above #1 says the same thing twice. */}
          {yourRow &&
            !sorted
              .slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
              .some((r) => r.address === yourRow.address) && (
            <div className="grid grid-cols-[56px_1fr_120px_140px_140px] items-center px-5 h-row rounded-sm border border-brand bg-brand/10 shadow-button">
              <div className="font-mono text-caption text-brand font-bold">YOU</div>
              <div className="font-mono text-caption text-ink truncate flex items-center gap-2">
                <span className="num text-ink-2">#{yourRow.rank}</span>
                <span className="font-semibold">{formatAddress(yourRow.address)}</span>
              </div>
              <div className="text-right num text-body text-ink font-bold">
                {yourRow.points.toLocaleString()}
              </div>
              <div className="text-right num text-caption text-ink-2">
                ${yourRow.totalDeposited.toLocaleString()}
              </div>
              <div className="text-right num text-caption text-accent-green">
                ${yourRow.totalPremium.toLocaleString()}
              </div>
            </div>
          )}

          {loading && (
            <div className="light-card px-5 py-16 flex items-center justify-center">
              <Loader2 size={20} className="animate-spin text-ink-2" />
            </div>
          )}

          {!loading && loadError && rows.length === 0 && (
            <div className="notice notice-warn">
              Couldn&apos;t load the leaderboard: {loadError}. It retries every two
              minutes, and reopening the tab retries immediately.
            </div>
          )}

          {!loading && !loadError && sorted.length === 0 && (
            <div className="light-card">
              <EmptyState
                icon={Trophy}
                title="No participants yet."
                hint="Be the first to deposit — every covered call and every cash-secured put earns points the moment the upfront lands."
              />
            </div>
          )}
          {!loading && sorted.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE).map((row) => {
            const isYou = !!address && row.address === address
            return (
            <div
              key={row.address}
              className={
                'card-interactive grid grid-cols-[56px_1fr_120px_140px_140px] items-center px-5 h-row ' +
                (isYou
                  /* Your own row, marked where it belongs rather than lifted
                     out of the order — the rank beside it is the point. */
                  ? 'rounded-sm border border-brand bg-brand/10 shadow-button'
                  : 'light-card')
              }
            >
              <Rank rank={row.rank} />
              <div className="font-mono text-caption text-ink truncate flex items-center gap-2">
                {formatAddress(row.address)}
                {isYou && (
                  <span className="font-mono text-micro uppercase tracking-wider text-brand font-bold">
                    you
                  </span>
                )}
              </div>
              <div className="text-right num text-body text-ink font-semibold">
                {row.points.toLocaleString()}
              </div>
              <div className="text-right num text-caption text-ink-2">
                ${row.totalDeposited.toLocaleString()}
              </div>
              <div className="text-right num text-caption text-accent-green">
                ${row.totalPremium.toLocaleString()}
              </div>
            </div>
            )
          })}

          </div>
        </div>

        {/* Horizontal pagination */}
        {sorted.length > 0 && (
        <div className="mt-3 flex items-center justify-between font-mono text-tiny text-ink-2">
          <div>
            total deposits ${(totalDeposits / 1_000_000).toFixed(2)}M
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="press w-8 h-8 flex items-center justify-center rounded-sm border border-line bg-card text-ink hover:bg-raised disabled:opacity-30 disabled:cursor-not-allowed transition"
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
              className="press w-8 h-8 flex items-center justify-center rounded-sm border border-line bg-card text-ink hover:bg-raised disabled:opacity-30 disabled:cursor-not-allowed transition"
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
