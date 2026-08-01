'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useWalletContext } from '@/providers/WalletProvider'
import { formatUsdc, formatXlm } from '@/lib/utils'
import { ExternalLink, Loader2 } from 'lucide-react'
import { OnChainActivity } from '@/components/shared/OnChainActivity'

// Mirrors DbPosition from the /api/vault/positions response. Positions live in
// the shared DB, so they show — and can be claimed — from any device.
interface Position {
  id: string
  address: string
  type: 'call' | 'put'
  asset: string
  collateralAmount: number
  strikePrice: number | null
  apr: number | null
  premium: number
  depositHash: string
  premiumHash: string | null
  expiryIso: string | null
  expiryLabel: string
  settled: boolean
}

// Mirrors the /api/vault/portfolio response.
//
// Nothing on this screen recomputes a Greek. The requirement is that displayed
// risk matches the pricing engine's own output, and a client-side re-derivation
// would be a second opinion that drifts the moment either side changes. The
// numbers arrive already negated for the writer (lib/portfolio.ts owns that
// flip); all this file does is choose units and labels.
interface PortfolioGreeks {
  /** Whose book: the wallet is short every option it opened. */
  basis: 'writer'
  /** Underlying units. Negative = short XLM. */
  netDelta: number
  /** USD per 1.00 of σ. Displayed per vol point, so divided by 100. */
  netVega: number
  pricedPositions: number
}

interface Portfolio {
  source: 'contract' | 'database'
  counts: { open: number; awaitingSettlement: number; settled: number }
  greeks: PortfolioGreeks | null
  market: { spot: number } | null
}

function daysRemaining(expiryIso: string | null): number {
  if (!expiryIso) return 0
  const ms = new Date(expiryIso).getTime() - Date.now()
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)))
}

function isExpired(expiryIso: string | null): boolean {
  if (!expiryIso) return false
  return new Date(expiryIso).getTime() <= Date.now()
}

/** Signed, with a real minus sign — the sign is the point of these numbers. */
function signed(n: number, digits = 2): string {
  const body = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
  return `${n < 0 ? '−' : '+'}${body}`
}

/**
 * Portfolio-level risk, straight from /api/vault/portfolio.
 *
 * The sign convention gets its own line on screen rather than a tooltip: a
 * reader who assumes these are the option's Greeks reads every number
 * backwards, and that is a worse failure than showing nothing.
 */
function RiskPanel({ portfolio }: { portfolio: Portfolio }) {
  const g = portfolio.greeks

  // Absent Greeks are not zero risk, and must never render as zero. Say which
  // of the two reasons it is.
  const absence =
    portfolio.counts.open === 0
      ? 'nothing open to price — expired positions settle at a price already fixed by the oracle'
      : !portfolio.market
        ? 'price feed unavailable, so live risk cannot be computed'
        : 'positions could not be priced'

  return (
    <div className="light-card rounded-sm p-5 mb-3">
      <div className="flex items-baseline justify-between flex-wrap gap-x-6 gap-y-1 mb-4">
        <div className="font-mono text-[11px] uppercase text-ink-2 tracking-wider">
          Portfolio risk
        </div>
        <div className="font-mono text-[11px] text-ink-2">
          you wrote these options, so your book carries the opposite sign to the
          option itself
        </div>
      </div>

      {g ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div>
            <div className="font-mono text-[11px] uppercase text-ink-2 tracking-wider">
              Net delta
            </div>
            <div className="num text-xl font-bold text-ink mt-0.5">
              {signed(g.netDelta)}{' '}
              <span className="text-sm font-normal text-ink-2">XLM</span>
            </div>
            <div className="font-mono text-[11px] text-ink-2 mt-1">
              {g.netDelta < 0 ? 'short' : 'long'} the underlying · the same
              directional exposure as holding{' '}
              {signed(g.netDelta, 0)} XLM
            </div>
          </div>

          <div>
            <div className="font-mono text-[11px] uppercase text-ink-2 tracking-wider">
              Net vega
            </div>
            <div className="num text-xl font-bold text-ink mt-0.5">
              {signed(g.netVega / 100)}{' '}
              <span className="text-sm font-normal text-ink-2">USD / vol pt</span>
            </div>
            <div className="font-mono text-[11px] text-ink-2 mt-1">
              {g.netVega < 0 ? 'short' : 'long'} volatility · P&L per 1 point of
              implied vol
            </div>
          </div>

          {g.pricedPositions < portfolio.counts.open && (
            <div className="sm:col-span-2 font-mono text-[11px] text-[#eab308]">
              priced {g.pricedPositions} of {portfolio.counts.open} open
              positions — the rest could not be priced and are not in these
              totals
            </div>
          )}
        </div>
      ) : (
        <div className="font-mono text-xs text-ink-2">Not shown — {absence}.</div>
      )}
    </div>
  )
}

export default function DashboardPage() {
  const { connected, connect, address } = useWalletContext()
  const [positions, setPositions] = useState<Position[]>([])
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null)
  const [loading, setLoading] = useState(false)
  const [claimingId, setClaimingId] = useState<string | null>(null)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const refresh = async () => {
    if (!address) {
      setPositions([])
      setPortfolio(null)
      return
    }
    setLoading(true)
    const q = encodeURIComponent(address)
    // Independent on purpose: the risk panel is priced against a live feed and
    // is the more fragile of the two. If it fails the position list still
    // renders, which is the part the user needs to act on.
    const [list, risk] = await Promise.allSettled([
      fetch(`/api/vault/positions?address=${q}`).then((r) => r.json()),
      fetch(`/api/vault/portfolio?address=${q}`).then((r) => r.json()),
    ])
    if (list.status === 'fulfilled' && list.value?.ok) {
      setPositions(list.value.positions as Position[])
    }
    setPortfolio(
      risk.status === 'fulfilled' && risk.value?.ok ? (risk.value as Portfolio) : null
    )
    setLoading(false)
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])

  const totalPremium = positions.reduce((s, p) => s + p.premium, 0)
  const totalNotional = positions.reduce(
    (s, p) =>
      s +
      (p.type === 'call'
        ? p.collateralAmount * (p.strikePrice ?? 0)
        : p.collateralAmount),
    0
  )

  const handleClaim = async (p: Position) => {
    setClaimingId(p.id)
    setToast(null)
    try {
      // Server reads type/strike/expiry/collateral from the deposit record
      // it logged at deposit time, so the client only identifies which
      // position to settle. See /api/vault/claim for the binding logic.
      const res = await fetch('/api/vault/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: p.address,
          depositHash: p.depositHash,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Claim failed')
      await refresh()
      setToast({
        kind: 'ok',
        text: `✓ ${data.outcome === 'kept' ? 'Kept' : 'Assigned'} · received ${data.payoutAmount} ${data.payoutAsset}`,
      })
    } catch (e: any) {
      setToast({ kind: 'err', text: e?.message ?? 'Claim failed' })
    } finally {
      setClaimingId(null)
      setTimeout(() => setToast(null), 7000)
    }
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-10">
      <div className="mb-8 flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="font-mono text-xs text-ink-2">~/dashboard</div>
          <h1 className="text-3xl font-bold text-ink mt-1">Your positions</h1>
        </div>
        {connected && positions.length > 0 && (
          <div className="flex gap-6 font-mono text-xs">
            <div>
              <div className="text-ink-2 uppercase tracking-wider">
                Open positions
              </div>
              <div className="num text-xl font-bold text-ink">
                {positions.filter((p) => !p.settled).length}
              </div>
            </div>
            <div>
              <div className="text-ink-2 uppercase tracking-wider">
                Upfront earned
              </div>
              <div className="num text-xl font-bold text-[#22c55e]">
                ${totalPremium.toFixed(2)}
              </div>
            </div>
            <div>
              <div className="text-ink-2 uppercase tracking-wider">
                Notional
              </div>
              <div className="num text-xl font-bold text-ink">
                ${totalNotional.toFixed(2)}
              </div>
            </div>
          </div>
        )}
      </div>

      {toast && (
        <div
          className={
            'mb-4 p-3 border rounded-sm font-mono text-xs ' +
            (toast.kind === 'ok'
              ? 'border-[#22c55e]/40 bg-[#22c55e]/10 text-[#22c55e]'
              : 'border-[#ef4444]/40 bg-[#ef4444]/10 text-[#ef4444]')
          }
        >
          {toast.text}
        </div>
      )}

      {!connected && (
        <div className="light-card p-8 rounded-sm text-center">
          <div className="font-mono text-sm text-ink-2 mb-4">
            Connect wallet to view positions
          </div>
          <button
            onClick={connect}
            className="h-10 px-6 bg-inverse text-cream font-mono text-sm rounded-sm hover:bg-line-2"
          >
            connect
          </button>
        </div>
      )}

      {connected && loading && positions.length === 0 && (
        <div className="light-card p-12 rounded-sm text-center">
          <div className="font-mono text-sm text-ink-2 inline-flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" /> Loading positions…
          </div>
        </div>
      )}

      {connected && !loading && positions.length === 0 && (
        <div className="light-card p-12 rounded-sm text-center">
          <div className="font-mono text-sm text-ink-2 mb-4">
            No active positions. Start earning.
          </div>
          <Link
            href="/earn"
            className="inline-flex h-10 px-6 items-center bg-inverse text-cream font-mono text-sm rounded-sm hover:bg-line-2"
          >
            go to earn
          </Link>
        </div>
      )}

      {connected && portfolio && positions.length > 0 && (
        <RiskPanel portfolio={portfolio} />
      )}

      {connected && positions.length > 0 && (
        <div className="space-y-3">
          {positions.map((p) => {
            const days = daysRemaining(p.expiryIso)
            const expired = isExpired(p.expiryIso)
            const isCall = p.type === 'call'
            const iconSrc = isCall ? '/xlm.png' : '/lusd.png'
            return (
              <div
                key={p.id}
                className="light-card rounded-sm p-5 grid grid-cols-1 md:grid-cols-[1.3fr_1fr_1fr_1fr_auto] gap-5 items-center"
              >
                <div className="flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={iconSrc}
                    alt={p.asset}
                    className="w-10 h-10 rounded-full shrink-0"
                  />
                  <div>
                    <div className="font-mono font-semibold text-ink">
                      {p.asset} {isCall ? 'Covered Call' : 'Cash-Secured Put'}
                    </div>
                    <div className="font-mono text-[11px] text-ink-2">
                      strike ${(p.strikePrice ?? 0).toFixed(4)} · {p.expiryLabel}
                    </div>
                  </div>
                </div>

                <div>
                  <div className="font-mono text-[11px] uppercase text-ink-2 tracking-wider">
                    Collateral
                  </div>
                  <div className="num text-sm text-ink font-semibold mt-0.5">
                    {isCall
                      ? formatXlm(p.collateralAmount)
                      : formatUsdc(p.collateralAmount)}
                  </div>
                </div>

                <div>
                  <div className="font-mono text-[11px] uppercase text-ink-2 tracking-wider">
                    Upfront
                  </div>
                  <div className="num text-sm text-[#22c55e] font-semibold mt-0.5">
                    ${p.premium.toFixed(4)}{' '}
                    <span className="text-ink-2 font-normal">
                      ({(p.apr ?? 0).toFixed(2)}% APR)
                    </span>
                  </div>
                </div>

                <div>
                  <div className="font-mono text-[11px] uppercase text-ink-2 tracking-wider">
                    {p.settled ? 'Settled' : expired ? 'Ready to claim' : 'Expires in'}
                  </div>
                  <div className="num text-sm text-ink font-semibold mt-0.5">
                    {p.settled ? 'yes' : expired ? 'now' : `${days}d`}
                  </div>
                </div>

                <div className="flex items-center gap-3 justify-self-end">
                  {expired && !p.settled && (
                    <button
                      onClick={() => handleClaim(p)}
                      disabled={claimingId === p.id}
                      className="h-9 px-4 bg-[#eab308] text-ink font-mono text-xs font-bold rounded-sm hover:bg-[#f5b938] disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2 transition"
                    >
                      {claimingId === p.id && <Loader2 size={12} className="animate-spin" />}
                      claim
                    </button>
                  )}
                  <a
                    href={`https://stellarchain.io/tx/${p.depositHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-xs flex items-center gap-1 text-ink-2 hover:text-ink"
                    title="View deposit on explorer"
                  >
                    {p.depositHash.slice(0, 8)}…
                    <ExternalLink size={11} />
                  </a>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Live on-chain event feed — public, streamed from the ledger via
          Soroban RPC getEvents (the contract's own deposit/settle/fund events). */}
      <OnChainActivity />
    </div>
  )
}
