'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useWalletContext } from '@/providers/WalletProvider'
import { formatAddress } from '@/lib/utils'
import {
  Shield,
  X,
  Users,
  ArrowRightLeft,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Activity,
  MessageSquare,
  Star,
} from 'lucide-react'

type Tab = 'overview' | 'users' | 'transactions' | 'analytics' | 'feedback'

interface Stats {
  totalUsers: number
  totalTransactions: number
  totalDeposited: number
  totalPremium: number
  last24hUsers: number
  last24hTransactions: number
}

interface UserRow {
  address: string
  firstSeen: string
  lastSeen: string
  connectCount: number
  totalDeposited: number
  totalPremium: number
  points: number
  depositCount: number
}

interface TxRow {
  id: number
  address: string
  type: string
  subtype: string | null
  amount: number
  asset: string
  txHash: string | null
  premiumAmount: number | null
  metadata: any
  createdAt: string
}

interface AnalyticsSummary {
  totalEvents: number
  pageViews: number
  uniqueSessions: number
  uniqueVisitors24h: number
  walletConnects: number
  eventsByName: { event: string; count: number }[]
  topPaths: { path: string; count: number }[]
  actions: {
    deposits: number
    claims: number
    faucet: number
    swaps: number
    uniqueDepositors: number
  }
  daily: { day: string; pageViews: number; sessions: number }[]
}

interface FeedbackRow {
  id: number
  address: string | null
  rating: number | null
  category: string | null
  message: string
  path: string | null
  ip: string | null
  createdAt: string
}

interface FeedbackSummary {
  total: number
  avgRating: number | null
  ratedCount: number
}

export function AdminOverlay() {
  const { connected, address, signTransaction } = useWalletContext()
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('overview')
  const [stats, setStats] = useState<Stats | null>(null)
  const [users, setUsers] = useState<UserRow[]>([])
  const [usersTotal, setUsersTotal] = useState(0)
  const [usersPage, setUsersPage] = useState(0)
  const [txs, setTxs] = useState<TxRow[]>([])
  const [txsTotal, setTxsTotal] = useState(0)
  const [txsPage, setTxsPage] = useState(0)
  const [txTypeFilter, setTxTypeFilter] = useState('')
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null)
  const [feedback, setFeedback] = useState<FeedbackRow[]>([])
  const [feedbackTotal, setFeedbackTotal] = useState(0)
  const [feedbackPage, setFeedbackPage] = useState(0)
  const [feedbackSummary, setFeedbackSummary] = useState<FeedbackSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const authInProgress = useRef(false)

  const PAGE_SIZE = 20

  // Authenticate admin via wallet signature when wallet connects
  useEffect(() => {
    if (!connected || !address || !signTransaction) {
      setIsAdmin(false)
      setSessionToken(null)
      setOpen(false)
      return
    }
    if (authInProgress.current) return
    authInProgress.current = true
    setAuthError(null)

    ;(async () => {
      try {
        // Step 1: Request challenge
        const challengeRes = await fetch('/api/admin/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'challenge', address }),
        })
        if (challengeRes.status === 403) {
          // Not an admin wallet — silently ignore
          setIsAdmin(false)
          return
        }
        const challengeData = await challengeRes.json()
        if (!challengeData.ok) {
          setIsAdmin(false)
          return
        }

        // Step 2: Sign the challenge transaction with wallet
        const signedXdr = await signTransaction(challengeData.xdr)

        // Step 3: Verify signature and get session token
        const verifyRes = await fetch('/api/admin/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'verify',
            challengeId: challengeData.challengeId,
            signedXdr,
          }),
        })
        const verifyData = await verifyRes.json()
        if (verifyData.ok && verifyData.token) {
          setSessionToken(verifyData.token)
          setIsAdmin(true)
        } else {
          setAuthError(verifyData.error ?? 'auth failed')
          setIsAdmin(false)
        }
      } catch (e: any) {
        // User rejected wallet signing or network error — silently ignore
        setIsAdmin(false)
      } finally {
        authInProgress.current = false
      }
    })()
  }, [connected, address, signTransaction])

  const adminHeaders: Record<string, string> = sessionToken
    ? { 'x-admin-token': sessionToken }
    : {}

  // Fetch users
  const fetchUsers = useCallback(
    (page: number) => {
      if (!sessionToken) return
      setLoading(true)
      fetch(`/api/admin/users?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`, {
        headers: adminHeaders,
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.ok) {
            setUsers(data.rows)
            setUsersTotal(data.total)
          }
        })
        .catch(() => {})
        .finally(() => setLoading(false))
    },
    [sessionToken]
  )

  // Fetch transactions
  const fetchTxs = useCallback(
    (page: number, type: string) => {
      if (!sessionToken) return
      setLoading(true)
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      })
      if (type) params.set('type', type)
      fetch(`/api/admin/transactions?${params}`, {
        headers: adminHeaders,
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.ok) {
            setTxs(data.rows)
            setTxsTotal(data.total)
          }
        })
        .catch(() => {})
        .finally(() => setLoading(false))
    },
    [sessionToken]
  )

  // Fetch analytics summary
  const fetchAnalytics = useCallback(() => {
    if (!sessionToken) return
    setLoading(true)
    fetch('/api/admin/analytics', { headers: adminHeaders })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) setAnalytics(data.summary)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [sessionToken])

  // Fetch feedback
  const fetchFeedback = useCallback(
    (page: number) => {
      if (!sessionToken) return
      setLoading(true)
      fetch(`/api/admin/feedback?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`, {
        headers: adminHeaders,
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.ok) {
            setFeedback(data.rows)
            setFeedbackTotal(data.total)
            setFeedbackSummary(data.summary)
          }
        })
        .catch(() => {})
        .finally(() => setLoading(false))
    },
    [sessionToken]
  )

  // Refresh stats when panel opens
  useEffect(() => {
    if (open && sessionToken && tab === 'overview') {
      fetch('/api/admin/stats', { headers: adminHeaders })
        .then((r) => r.json())
        .then((data) => {
          if (data?.ok) setStats(data.stats)
        })
        .catch(() => {})
    }
  }, [open, sessionToken, tab])

  useEffect(() => {
    if (open && tab === 'users') fetchUsers(usersPage)
  }, [open, tab, usersPage, fetchUsers])

  useEffect(() => {
    if (open && tab === 'transactions') fetchTxs(txsPage, txTypeFilter)
  }, [open, tab, txsPage, txTypeFilter, fetchTxs])

  useEffect(() => {
    if (open && tab === 'analytics') fetchAnalytics()
  }, [open, tab, fetchAnalytics])

  useEffect(() => {
    if (open && tab === 'feedback') fetchFeedback(feedbackPage)
  }, [open, tab, feedbackPage, fetchFeedback])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  if (!isAdmin) return null

  return (
    <>
      {/* Floating trigger — subtle shield icon, bottom-right */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-50 w-10 h-10 rounded-full bg-inverse text-[#eab308] flex items-center justify-center shadow-lg hover:scale-110 transition opacity-60 hover:opacity-100"
          title="Admin panel"
        >
          <Shield size={18} />
        </button>
      )}

      {/* Overlay panel */}
      {open && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />

          {/* Panel — slides from right */}
          <div className="fixed top-0 right-0 z-50 h-full w-full max-w-3xl bg-card shadow-2xl overflow-y-auto">
            {/* Header */}
            <div className="sticky top-0 bg-inverse px-6 py-4 flex items-center justify-between z-10">
              <div className="flex items-center gap-3">
                <Shield size={20} className="text-[#eab308]" />
                <span className="font-mono text-sm text-cream font-semibold">
                  Admin Panel
                </span>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="text-cream/60 hover:text-cream transition"
              >
                <X size={20} />
              </button>
            </div>

            <div className="p-6 space-y-6">
              {/* Tabs */}
              <div className="flex flex-wrap gap-2 font-mono text-sm">
                {([
                  { key: 'overview' as Tab, label: 'Overview', icon: BarChart3 },
                  { key: 'analytics' as Tab, label: 'Analytics', icon: Activity },
                  { key: 'users' as Tab, label: 'Users', icon: Users },
                  { key: 'transactions' as Tab, label: 'Transactions', icon: ArrowRightLeft },
                  { key: 'feedback' as Tab, label: 'Feedback', icon: MessageSquare },
                ]).map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    onClick={() => setTab(key)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-sm border transition ${
                      tab === key
                        ? 'bg-inverse text-cream border-ink'
                        : 'bg-card text-ink-2 border-line hover:bg-surface'
                    }`}
                  >
                    <Icon size={14} />
                    {label}
                  </button>
                ))}
              </div>

              {/* Overview */}
              {tab === 'overview' && stats && (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {[
                    { label: 'Total Users', value: stats.totalUsers.toLocaleString(), color: 'text-ink' },
                    { label: 'Total Transactions', value: stats.totalTransactions.toLocaleString(), color: 'text-ink' },
                    { label: 'Total Deposited', value: `$${stats.totalDeposited.toLocaleString()}`, color: 'text-ink' },
                    { label: 'Total Premium Paid', value: `$${stats.totalPremium.toLocaleString()}`, color: 'text-[#22c55e]' },
                    { label: 'Users (24h)', value: stats.last24hUsers.toLocaleString(), color: 'text-[#eab308]' },
                    { label: 'Transactions (24h)', value: stats.last24hTransactions.toLocaleString(), color: 'text-[#eab308]' },
                  ].map((s) => (
                    <div key={s.label} className="light-card rounded-sm p-5">
                      <div className="font-mono text-[11px] uppercase tracking-wider text-ink-2 mb-1">
                        {s.label}
                      </div>
                      <div className={`font-mono text-2xl font-bold ${s.color}`}>{s.value}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Users */}
              {tab === 'users' && (
                <div className="light-card rounded-sm overflow-x-auto">
                  <div className="min-w-[700px]">
                    <div className="grid grid-cols-[1fr_90px_90px_60px_90px_90px_70px] px-5 py-3 border-b border-line font-mono text-[11px] uppercase tracking-wider text-ink-2">
                      <div>wallet</div>
                      <div className="text-right">first seen</div>
                      <div className="text-right">last seen</div>
                      <div className="text-right">visits</div>
                      <div className="text-right">deposited</div>
                      <div className="text-right">premium</div>
                      <div className="text-right">points</div>
                    </div>
                    {loading && (
                      <div className="px-5 py-10 flex justify-center">
                        <Loader2 size={20} className="animate-spin text-ink-2" />
                      </div>
                    )}
                    {!loading && users.map((u) => (
                      <div
                        key={u.address}
                        className="grid grid-cols-[1fr_90px_90px_60px_90px_90px_70px] items-center px-5 py-3 dashed-row hover:bg-surface transition"
                      >
                        <div className="font-mono text-xs text-ink truncate">
                          {formatAddress(u.address)}
                        </div>
                        <div className="text-right font-mono text-[11px] text-ink-2">
                          {new Date(u.firstSeen).toLocaleDateString()}
                        </div>
                        <div className="text-right font-mono text-[11px] text-ink-2">
                          {new Date(u.lastSeen).toLocaleDateString()}
                        </div>
                        <div className="text-right num text-xs text-ink-2">
                          {u.connectCount}
                        </div>
                        <div className="text-right num text-xs text-ink">
                          ${u.totalDeposited.toLocaleString()}
                        </div>
                        <div className="text-right num text-xs text-[#22c55e]">
                          ${u.totalPremium.toLocaleString()}
                        </div>
                        <div className="text-right num text-xs font-semibold text-ink">
                          {u.points.toLocaleString()}
                        </div>
                      </div>
                    ))}
                    {!loading && users.length === 0 && (
                      <div className="px-5 py-10 text-center font-mono text-xs text-ink-2">
                        No users yet
                      </div>
                    )}
                  </div>
                  <Pagination page={usersPage} setPage={setUsersPage} total={usersTotal} pageSize={PAGE_SIZE} />
                </div>
              )}

              {/* Transactions */}
              {tab === 'transactions' && (
                <div>
                  <div className="flex items-center gap-3 mb-3">
                    <select
                      value={txTypeFilter}
                      onChange={(e) => {
                        setTxTypeFilter(e.target.value)
                        setTxsPage(0)
                      }}
                      className="font-mono text-xs px-3 py-1.5 rounded-sm border border-line bg-card text-ink"
                    >
                      <option value="">All types</option>
                      <option value="deposit">Deposits</option>
                      <option value="claim">Claims</option>
                      <option value="faucet">Faucet</option>
                    </select>
                  </div>
                  <div className="light-card rounded-sm overflow-x-auto">
                    <div className="min-w-[700px]">
                      <div className="grid grid-cols-[90px_1fr_70px_50px_90px_60px_100px] px-5 py-3 border-b border-line font-mono text-[11px] uppercase tracking-wider text-ink-2">
                        <div>time</div>
                        <div>wallet</div>
                        <div>type</div>
                        <div>side</div>
                        <div className="text-right">amount</div>
                        <div>asset</div>
                        <div>tx hash</div>
                      </div>
                      {loading && (
                        <div className="px-5 py-10 flex justify-center">
                          <Loader2 size={20} className="animate-spin text-ink-2" />
                        </div>
                      )}
                      {!loading && txs.map((tx) => (
                        <div
                          key={tx.id}
                          className="grid grid-cols-[90px_1fr_70px_50px_90px_60px_100px] items-center px-5 py-3 dashed-row hover:bg-surface transition"
                        >
                          <div className="font-mono text-[11px] text-ink-2">
                            {new Date(tx.createdAt).toLocaleString('tr-TR', {
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </div>
                          <div className="font-mono text-xs text-ink truncate">
                            {formatAddress(tx.address)}
                          </div>
                          <div className="font-mono text-xs">
                            <span
                              className={`px-1.5 py-0.5 rounded-sm text-[10px] uppercase ${
                                tx.type === 'deposit'
                                  ? 'bg-[#22c55e]/15 text-[#22c55e]'
                                  : tx.type === 'claim'
                                  ? 'bg-[#eab308]/15 text-[#eab308]'
                                  : 'bg-ink-2/15 text-ink-2'
                              }`}
                            >
                              {tx.type}
                            </span>
                          </div>
                          <div className="font-mono text-[11px] text-ink-2">
                            {tx.subtype ?? '—'}
                          </div>
                          <div className="text-right num text-xs text-ink">
                            {tx.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </div>
                          <div className="font-mono text-[11px] text-ink-2">{tx.asset}</div>
                          <div className="font-mono text-[11px] text-ink-2 truncate">
                            {tx.txHash ? (
                              <a
                                href={`https://stellar.expert/explorer/testnet/tx/${tx.txHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:text-ink underline"
                              >
                                {tx.txHash.slice(0, 8)}...
                              </a>
                            ) : (
                              '—'
                            )}
                          </div>
                        </div>
                      ))}
                      {!loading && txs.length === 0 && (
                        <div className="px-5 py-10 text-center font-mono text-xs text-ink-2">
                          No transactions yet
                        </div>
                      )}
                    </div>
                    <Pagination page={txsPage} setPage={setTxsPage} total={txsTotal} pageSize={PAGE_SIZE} />
                  </div>
                </div>
              )}

              {/* Analytics */}
              {tab === 'analytics' && (
                <div className="space-y-6">
                  {loading && !analytics && (
                    <div className="px-5 py-10 flex justify-center">
                      <Loader2 size={20} className="animate-spin text-ink-2" />
                    </div>
                  )}
                  {analytics && (
                    <>
                      {/* Top-line usage metrics */}
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                        {[
                          { label: 'Page Views', value: analytics.pageViews.toLocaleString(), color: 'text-ink' },
                          { label: 'Unique Sessions', value: analytics.uniqueSessions.toLocaleString(), color: 'text-ink' },
                          { label: 'Visitors (24h)', value: analytics.uniqueVisitors24h.toLocaleString(), color: 'text-[#eab308]' },
                          { label: 'Wallet Connects', value: analytics.walletConnects.toLocaleString(), color: 'text-ink' },
                          { label: 'Unique Depositors', value: analytics.actions.uniqueDepositors.toLocaleString(), color: 'text-[#22c55e]' },
                          { label: 'Total Events', value: analytics.totalEvents.toLocaleString(), color: 'text-ink-2' },
                        ].map((s) => (
                          <div key={s.label} className="light-card rounded-sm p-5">
                            <div className="font-mono text-[11px] uppercase tracking-wider text-ink-2 mb-1">
                              {s.label}
                            </div>
                            <div className={`font-mono text-2xl font-bold ${s.color}`}>{s.value}</div>
                          </div>
                        ))}
                      </div>

                      {/* Daily page views (last 14 days) */}
                      <div className="light-card rounded-sm p-5">
                        <div className="font-mono text-[11px] uppercase tracking-wider text-ink-2 mb-4">
                          Page views · last 14 days
                        </div>
                        <div className="flex items-end gap-1.5 h-32">
                          {analytics.daily.map((d) => {
                            const max = Math.max(1, ...analytics.daily.map((x) => x.pageViews))
                            const pct = (d.pageViews / max) * 100
                            return (
                              <div key={d.day} className="flex-1 flex flex-col items-center gap-1 group">
                                <div className="relative w-full flex items-end h-full">
                                  <div
                                    className="w-full bg-[#eab308]/70 group-hover:bg-[#eab308] rounded-t-sm transition"
                                    style={{ height: `${pct}%`, minHeight: d.pageViews > 0 ? '4px' : '0' }}
                                    title={`${d.day}: ${d.pageViews} views, ${d.sessions} sessions`}
                                  />
                                </div>
                                <div className="font-mono text-[9px] text-ink-2">
                                  {d.day.slice(5)}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>

                      {/* Action funnel + events split */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="light-card rounded-sm p-5">
                          <div className="font-mono text-[11px] uppercase tracking-wider text-ink-2 mb-3">
                            On-chain actions
                          </div>
                          <div className="space-y-2 font-mono text-sm">
                            {[
                              { label: 'Deposits', value: analytics.actions.deposits },
                              { label: 'Claims', value: analytics.actions.claims },
                              { label: 'Swaps', value: analytics.actions.swaps },
                              { label: 'Faucet', value: analytics.actions.faucet },
                            ].map((a) => (
                              <div key={a.label} className="flex items-center justify-between">
                                <span className="text-ink-2">{a.label}</span>
                                <span className="num text-ink font-semibold">{a.value.toLocaleString()}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                        <div className="light-card rounded-sm p-5">
                          <div className="font-mono text-[11px] uppercase tracking-wider text-ink-2 mb-3">
                            Top events
                          </div>
                          <div className="space-y-2 font-mono text-sm">
                            {analytics.eventsByName.slice(0, 6).map((e) => (
                              <div key={e.event} className="flex items-center justify-between">
                                <span className="text-ink-2 truncate">{e.event}</span>
                                <span className="num text-ink font-semibold">{e.count.toLocaleString()}</span>
                              </div>
                            ))}
                            {analytics.eventsByName.length === 0 && (
                              <span className="text-ink-2">No events yet</span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Top paths */}
                      {analytics.topPaths.length > 0 && (
                        <div className="light-card rounded-sm p-5">
                          <div className="font-mono text-[11px] uppercase tracking-wider text-ink-2 mb-3">
                            Top pages
                          </div>
                          <div className="space-y-2 font-mono text-sm">
                            {analytics.topPaths.map((p) => (
                              <div key={p.path} className="flex items-center justify-between">
                                <span className="text-ink-2 truncate">{p.path}</span>
                                <span className="num text-ink font-semibold">{p.count.toLocaleString()}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Feedback */}
              {tab === 'feedback' && (
                <div className="space-y-4">
                  {feedbackSummary && (
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                      <div className="light-card rounded-sm p-5">
                        <div className="font-mono text-[11px] uppercase tracking-wider text-ink-2 mb-1">
                          Total Feedback
                        </div>
                        <div className="font-mono text-2xl font-bold text-ink">
                          {feedbackSummary.total.toLocaleString()}
                        </div>
                      </div>
                      <div className="light-card rounded-sm p-5">
                        <div className="font-mono text-[11px] uppercase tracking-wider text-ink-2 mb-1">
                          Avg Rating
                        </div>
                        <div className="font-mono text-2xl font-bold text-[#eab308] flex items-center gap-1">
                          {feedbackSummary.avgRating ?? '—'}
                          {feedbackSummary.avgRating !== null && (
                            <Star size={18} className="fill-[#eab308] text-[#eab308]" />
                          )}
                        </div>
                      </div>
                      <div className="light-card rounded-sm p-5">
                        <div className="font-mono text-[11px] uppercase tracking-wider text-ink-2 mb-1">
                          Rated
                        </div>
                        <div className="font-mono text-2xl font-bold text-ink">
                          {feedbackSummary.ratedCount.toLocaleString()}
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="light-card rounded-sm">
                    {loading && (
                      <div className="px-5 py-10 flex justify-center">
                        <Loader2 size={20} className="animate-spin text-ink-2" />
                      </div>
                    )}
                    {!loading && feedback.map((f) => (
                      <div key={f.id} className="px-5 py-4 dashed-row">
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-2">
                            {f.rating && (
                              <div className="flex items-center gap-0.5">
                                {Array.from({ length: f.rating }).map((_, i) => (
                                  <Star key={i} size={12} className="fill-[#eab308] text-[#eab308]" />
                                ))}
                              </div>
                            )}
                            {f.category && (
                              <span className="px-1.5 py-0.5 rounded-sm text-[10px] uppercase bg-ink-2/15 text-ink-2 font-mono">
                                {f.category}
                              </span>
                            )}
                          </div>
                          <span className="font-mono text-[11px] text-ink-2">
                            {new Date(f.createdAt).toLocaleString()}
                          </span>
                        </div>
                        <p className="text-sm text-ink whitespace-pre-wrap break-words">{f.message}</p>
                        <div className="font-mono text-[11px] text-ink-2 mt-1.5">
                          {f.address ? formatAddress(f.address) : 'anonymous'}
                          {f.path && <span> · {f.path}</span>}
                          {f.ip && <span> · {f.ip}</span>}
                        </div>
                      </div>
                    ))}
                    {!loading && feedback.length === 0 && (
                      <div className="px-5 py-10 text-center font-mono text-xs text-ink-2">
                        No feedback yet
                      </div>
                    )}
                    <Pagination page={feedbackPage} setPage={setFeedbackPage} total={feedbackTotal} pageSize={PAGE_SIZE} />
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </>
  )
}

function Pagination({
  page,
  setPage,
  total,
  pageSize,
}: {
  page: number
  setPage: (p: number) => void
  total: number
  pageSize: number
}) {
  if (total <= pageSize) return null
  return (
    <div className="px-5 py-3 flex items-center justify-end gap-3 font-mono text-[11px] text-ink-2">
      <button
        onClick={() => setPage(Math.max(0, page - 1))}
        disabled={page === 0}
        className="w-8 h-8 flex items-center justify-center rounded-sm border border-line bg-card text-ink hover:bg-surface disabled:opacity-30 disabled:cursor-not-allowed transition"
      >
        <ChevronLeft size={14} />
      </button>
      <span className="num">
        {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} of {total}
      </span>
      <button
        onClick={() => setPage(Math.min(Math.ceil(total / pageSize) - 1, page + 1))}
        disabled={(page + 1) * pageSize >= total}
        className="w-8 h-8 flex items-center justify-center rounded-sm border border-line bg-card text-ink hover:bg-surface disabled:opacity-30 disabled:cursor-not-allowed transition"
      >
        <ChevronRight size={14} />
      </button>
    </div>
  )
}
