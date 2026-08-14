'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useWalletContext } from '@/providers/WalletProvider'
import { formatUsdc, formatXlm } from '@/lib/utils'
import { ExternalLink, Loader2 } from 'lucide-react'
import { OnChainActivity } from '@/components/shared/OnChainActivity'

// Mirrors DbPosition from the /api/vault/positions response. Positions are read
// from contract state and mirrored in the shared DB, so they show from any
// device rather than from whichever browser opened them.
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
  /**
   * Contract-assigned id, or null for a position from the retired distributor
   * rail. Only the first kind can appear while the contract is reachable; the
   * second survives in the database mirror, and its book is closed.
   */
  positionId: number | null
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

/** The vault's whole book at one expiry, from contract state. Not this wallet. */
interface VaultExpiryLoad {
  callXlm: number
  putUsd: number
  maxCallXlm: number
  maxPutUsd: number
}

interface ExpiryBucket {
  expiryIso: string
  expiryLabel: string
  daysToExpiry: number
  positions: number
  callCollateralXlm: number
  putCollateralUsd: number
  premiumUsd: number
  netDelta: number | null
  netVega: number | null
  awaitingSettlement: number
  vault?: VaultExpiryLoad
}

interface Portfolio {
  source: 'contract' | 'database'
  counts: { open: number; awaitingSettlement: number; settled: number }
  /** Two tokens, deliberately never summed into one figure. */
  collateral: { callXlm: number; putUsd: number }
  premiumUsd: number
  greeks: PortfolioGreeks | null
  byExpiry: ExpiryBucket[]
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

function amount(n: number, digits = 2): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function pctFull(used: number, cap: number): number | null {
  if (!(cap > 0)) return null
  return Math.min(100, (used / cap) * 100)
}

/**
 * Asset-level exposure: what is locked, in which token, coming due when.
 *
 * The two legs are never added together. A call escrows XLM and a put escrows
 * cash, so a single "total collateral" would be a currency error — and one that
 * reads as a perfectly sensible number right up until someone sizes a decision
 * on it. The API refuses to produce that figure and so does this panel.
 *
 * The vault column is the whole book at that expiry, not this wallet's share.
 * It comes from the contract's own `exposure(kind, expiry)` view — the same
 * number `open` checks against `max_expiry` — so it answers "how much room is
 * left on this date" with the figure that will actually refuse the next
 * deposit, rather than with a database mirror of it.
 */
function ExposurePanel({ portfolio }: { portfolio: Portfolio }) {
  const buckets = portfolio.byExpiry
  if (buckets.length === 0) return null

  return (
    <div className="light-card rounded-sm p-5 mb-3">
      <div className="flex items-baseline justify-between flex-wrap gap-x-6 gap-y-1 mb-4">
        <div className="font-mono text-[11px] uppercase text-ink-2 tracking-wider">
          Asset exposure
        </div>
        <div className="font-mono text-[11px] text-ink-2">
          calls lock XLM, puts lock cash — separate tokens, so there is no
          combined total
        </div>
      </div>

      <div className="grid grid-cols-2 gap-5 mb-5">
        <div>
          <div className="font-mono text-[11px] uppercase text-ink-2 tracking-wider">
            Locked in calls
          </div>
          <div className="num text-xl font-bold text-ink mt-0.5">
            {amount(portfolio.collateral.callXlm)}{' '}
            <span className="text-sm font-normal text-ink-2">XLM</span>
          </div>
        </div>
        <div>
          <div className="font-mono text-[11px] uppercase text-ink-2 tracking-wider">
            Locked in puts
          </div>
          <div className="num text-xl font-bold text-ink mt-0.5">
            <span className="text-sm font-normal text-ink-2">$</span>
            {amount(portfolio.collateral.putUsd)}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[560px]">
          <div className="grid grid-cols-[1.1fr_0.9fr_0.9fr_0.8fr_1.1fr] gap-3 font-mono text-[11px] uppercase text-ink-2 tracking-wider pb-2 border-b border-line">
            <div>Expiry</div>
            <div className="text-right">Calls (XLM)</div>
            <div className="text-right">Puts (USD)</div>
            <div className="text-right">Upfront</div>
            <div className="text-right">Vault load at this expiry</div>
          </div>

          {buckets.map((b) => {
            const callPct = b.vault ? pctFull(b.vault.callXlm, b.vault.maxCallXlm) : null
            const putPct = b.vault ? pctFull(b.vault.putUsd, b.vault.maxPutUsd) : null
            const due = b.awaitingSettlement > 0 && b.awaitingSettlement === b.positions

            return (
              <div
                key={b.expiryIso}
                className="grid grid-cols-[1.1fr_0.9fr_0.9fr_0.8fr_1.1fr] gap-3 py-2.5 border-b border-line last:border-0 items-baseline"
              >
                <div>
                  <div className="font-mono text-xs text-ink">{b.expiryLabel}</div>
                  <div className="font-mono text-[11px] text-ink-2">
                    {due
                      ? 'awaiting settlement'
                      : `in ${Math.ceil(b.daysToExpiry)}d · ${b.positions} position${b.positions === 1 ? '' : 's'}`}
                  </div>
                </div>
                <div className="num text-xs text-ink text-right">
                  {b.callCollateralXlm > 0 ? amount(b.callCollateralXlm) : '—'}
                </div>
                <div className="num text-xs text-ink text-right">
                  {b.putCollateralUsd > 0 ? amount(b.putCollateralUsd) : '—'}
                </div>
                <div className="num text-xs text-[#22c55e] text-right">
                  ${amount(b.premiumUsd, 4)}
                </div>
                <div className="num text-[11px] text-ink-2 text-right">
                  {callPct === null && putPct === null ? (
                    'unknown'
                  ) : (
                    <>
                      calls {callPct?.toFixed(1) ?? '—'}% · puts{' '}
                      {putPct?.toFixed(1) ?? '—'}% full
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {buckets.some((b) => b.vault) && (
        <div className="font-mono text-[11px] text-ink-2 mt-3">
          Vault load is every writer&apos;s collateral at that expiry against the
          contract&apos;s own per-expiry cap, read from contract state — not your
          share.
        </div>
      )}
    </div>
  )
}

export default function DashboardPage() {
  const { connected, connect, address } = useWalletContext()
  const [positions, setPositions] = useState<Position[]>([])
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null)
  const [loading, setLoading] = useState(false)
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
        <>
          <RiskPanel portfolio={portfolio} />
          <ExposurePanel portfolio={portfolio} />
        </>
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
                    {p.settled ? 'Settled' : expired ? 'Awaiting settlement' : 'Expires in'}
                  </div>
                  <div className="num text-sm text-ink font-semibold mt-0.5">
                    {p.settled ? 'yes' : expired ? 'now' : `${days}d`}
                  </div>
                </div>

                <div className="flex items-center gap-3 justify-self-end">
                  {/*
                    Nothing to offer, and that is the finished state rather than
                    a gap. A contract position settles on chain and needs
                    nobody's permission. A position from the retired rail has
                    already been paid: the book was settled in full from the
                    distributor and closed, so no row here is waiting on us.
                  */}
                  {expired && !p.settled && p.positionId !== null && (
                    <span
                      className="font-mono text-[11px] text-ink-2"
                      title="Settled by the contract against the oracle price at expiry. Anyone can trigger it; a scheduled runner does."
                    >
                      settles on chain
                    </span>
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
