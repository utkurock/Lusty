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
} from 'lucide-react'

type Tab = 'overview' | 'users' | 'transactions'

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
          className="fixed bottom-6 right-6 z-50 w-10 h-10 rounded-full bg-[#1a1a1a] text-[#eab308] flex items-center justify-center shadow-lg hover:scale-110 transition opacity-60 hover:opacity-100"
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
          <div className="fixed top-0 right-0 z-50 h-full w-full max-w-3xl bg-[#f0ece3] shadow-2xl overflow-y-auto">
            {/* Header */}
            <div className="sticky top-0 bg-[#1a1a1a] px-6 py-4 flex items-center justify-between z-10">
              <div className="flex items-center gap-3">
                <Shield size={20} className="text-[#eab308]" />
                <span className="font-mono text-sm text-[#e8e4d9] font-semibold">
                  Admin Panel
                </span>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="text-[#e8e4d9]/60 hover:text-[#e8e4d9] transition"
              >
                <X size={20} />
              </button>
            </div>

            <div className="p-6 space-y-6">
              {/* Tabs */}
              <div className="flex gap-2 font-mono text-sm">
                {([
                  { key: 'overview' as Tab, label: 'Overview', icon: BarChart3 },
                  { key: 'users' as Tab, label: 'Users', icon: Users },
                  { key: 'transactions' as Tab, label: 'Transactions', icon: ArrowRightLeft },
                ]).map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    onClick={() => setTab(key)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-sm border transition ${
                      tab === key
                        ? 'bg-[#1a1a1a] text-[#e8e4d9] border-[#1a1a1a]'
                        : 'bg-[#f0ece3] text-[#6b6560] border-[#c4bfb2] hover:bg-[#e8e4d9]'
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
                    { label: 'Total Users', value: stats.totalUsers.toLocaleString(), color: 'text-[#1a1a1a]' },
                    { label: 'Total Transactions', value: stats.totalTransactions.toLocaleString(), color: 'text-[#1a1a1a]' },
                    { label: 'Total Deposited', value: `$${stats.totalDeposited.toLocaleString()}`, color: 'text-[#1a1a1a]' },
                    { label: 'Total Premium Paid', value: `$${stats.totalPremium.toLocaleString()}`, color: 'text-[#22c55e]' },
                    { label: 'Users (24h)', value: stats.last24hUsers.toLocaleString(), color: 'text-[#eab308]' },
                    { label: 'Transactions (24h)', value: stats.last24hTransactions.toLocaleString(), color: 'text-[#eab308]' },
                  ].map((s) => (
                    <div key={s.label} className="light-card rounded-sm p-5">
                      <div className="font-mono text-[11px] uppercase tracking-wider text-[#6b6560] mb-1">
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
                    <div className="grid grid-cols-[1fr_90px_90px_60px_90px_90px_70px] px-5 py-3 border-b border-[#c4bfb2] font-mono text-[11px] uppercase tracking-wider text-[#6b6560]">
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
                        <Loader2 size={20} className="animate-spin text-[#6b6560]" />
                      </div>
                    )}
                    {!loading && users.map((u) => (
                      <div
                        key={u.address}
                        className="grid grid-cols-[1fr_90px_90px_60px_90px_90px_70px] items-center px-5 py-3 dashed-row hover:bg-[#e8e4d9] transition"
                      >
                        <div className="font-mono text-xs text-[#1a1a1a] truncate">
                          {formatAddress(u.address)}
                        </div>
                        <div className="text-right font-mono text-[11px] text-[#6b6560]">
                          {new Date(u.firstSeen).toLocaleDateString()}
                        </div>
                        <div className="text-right font-mono text-[11px] text-[#6b6560]">
                          {new Date(u.lastSeen).toLocaleDateString()}
                        </div>
                        <div className="text-right num text-xs text-[#6b6560]">
                          {u.connectCount}
                        </div>
                        <div className="text-right num text-xs text-[#1a1a1a]">
                          ${u.totalDeposited.toLocaleString()}
                        </div>
                        <div className="text-right num text-xs text-[#22c55e]">
                          ${u.totalPremium.toLocaleString()}
                        </div>
                        <div className="text-right num text-xs font-semibold text-[#1a1a1a]">
                          {u.points.toLocaleString()}
                        </div>
                      </div>
                    ))}
                    {!loading && users.length === 0 && (
                      <div className="px-5 py-10 text-center font-mono text-xs text-[#6b6560]">
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
                      className="font-mono text-xs px-3 py-1.5 rounded-sm border border-[#c4bfb2] bg-[#f0ece3] text-[#1a1a1a]"
                    >
                      <option value="">All types</option>
                      <option value="deposit">Deposits</option>
                      <option value="claim">Claims</option>
                      <option value="faucet">Faucet</option>
                    </select>
                  </div>
                  <div className="light-card rounded-sm overflow-x-auto">
                    <div className="min-w-[700px]">
                      <div className="grid grid-cols-[90px_1fr_70px_50px_90px_60px_100px] px-5 py-3 border-b border-[#c4bfb2] font-mono text-[11px] uppercase tracking-wider text-[#6b6560]">
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
                          <Loader2 size={20} className="animate-spin text-[#6b6560]" />
                        </div>
                      )}
                      {!loading && txs.map((tx) => (
                        <div
                          key={tx.id}
                          className="grid grid-cols-[90px_1fr_70px_50px_90px_60px_100px] items-center px-5 py-3 dashed-row hover:bg-[#e8e4d9] transition"
                        >
                          <div className="font-mono text-[11px] text-[#6b6560]">
                            {new Date(tx.createdAt).toLocaleString('tr-TR', {
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </div>
                          <div className="font-mono text-xs text-[#1a1a1a] truncate">
                            {formatAddress(tx.address)}
                          </div>
                          <div className="font-mono text-xs">
                            <span
                              className={`px-1.5 py-0.5 rounded-sm text-[10px] uppercase ${
                                tx.type === 'deposit'
                                  ? 'bg-[#22c55e]/15 text-[#22c55e]'
                                  : tx.type === 'claim'
                                  ? 'bg-[#eab308]/15 text-[#eab308]'
                                  : 'bg-[#6b6560]/15 text-[#6b6560]'
                              }`}
                            >
                              {tx.type}
                            </span>
                          </div>
                          <div className="font-mono text-[11px] text-[#6b6560]">
                            {tx.subtype ?? '—'}
                          </div>
                          <div className="text-right num text-xs text-[#1a1a1a]">
                            {tx.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </div>
                          <div className="font-mono text-[11px] text-[#6b6560]">{tx.asset}</div>
                          <div className="font-mono text-[11px] text-[#6b6560] truncate">
                            {tx.txHash ? (
                              <a
                                href={`https://stellar.expert/explorer/testnet/tx/${tx.txHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:text-[#1a1a1a] underline"
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
                        <div className="px-5 py-10 text-center font-mono text-xs text-[#6b6560]">
                          No transactions yet
                        </div>
                      )}
                    </div>
                    <Pagination page={txsPage} setPage={setTxsPage} total={txsTotal} pageSize={PAGE_SIZE} />
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
    <div className="px-5 py-3 flex items-center justify-end gap-3 font-mono text-[11px] text-[#6b6560]">
      <button
        onClick={() => setPage(Math.max(0, page - 1))}
        disabled={page === 0}
        className="w-8 h-8 flex items-center justify-center rounded-sm border border-[#c4bfb2] bg-[#f0ece3] text-[#1a1a1a] hover:bg-[#e8e4d9] disabled:opacity-30 disabled:cursor-not-allowed transition"
      >
        <ChevronLeft size={14} />
      </button>
      <span className="num">
        {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} of {total}
      </span>
      <button
        onClick={() => setPage(Math.min(Math.ceil(total / pageSize) - 1, page + 1))}
        disabled={(page + 1) * pageSize >= total}
        className="w-8 h-8 flex items-center justify-center rounded-sm border border-[#c4bfb2] bg-[#f0ece3] text-[#1a1a1a] hover:bg-[#e8e4d9] disabled:opacity-30 disabled:cursor-not-allowed transition"
      >
        <ChevronRight size={14} />
      </button>
    </div>
  )
}
