'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useWalletContext } from '@/providers/WalletProvider'
import { formatUsdc, formatXlm } from '@/lib/utils'
import { ExternalLink, Loader2, Wallet, LayoutList, ArrowRight } from 'lucide-react'
import { OnChainActivity } from '@/components/shared/OnChainActivity'
import { Panel } from '@/components/shared/Panel'
import { StatStrip } from '@/components/shared/StatStrip'
import { EmptyState } from '@/components/shared/EmptyState'
import { PageHeader } from '@/components/shared/PageHeader'
import { withinOracleWindow } from '@/lib/oracle-window'

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
   * How the contract resolved it. A covered call that is `assigned` gave up its
   * XLM and was paid cash; one that is `kept` got its XLM back. The distinction
   * is the whole answer to "where did my collateral go", so it is carried all
   * the way to the card rather than flattened into settled/not.
   */
  outcome?: 'open' | 'kept' | 'assigned'
  /** What settlement actually paid, in the token it paid in. */
  payout?: { amount: number; asset: 'XLM' | 'LUSD' } | null
  /**
   * Where the APR came from: measured at open, or reconstructed afterwards
   * from the day's close. Shown so a derived figure is never mistaken for the
   * one that was quoted.
   */
  aprSource?: 'recorded' | 'derived' | null
  /** Oracle price at expiry — the price the outcome was decided at. */
  settlePrice?: number | null
  settledAt?: string | null
  settleHash?: string | null
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
    <Panel
      title="Portfolio risk"
      note="you wrote these options, so your book carries the opposite sign to the option itself"
    >
      {g ? (
        <>
          <StatStrip
            stats={[
              {
                label: 'Net delta',
                value: signed(g.netDelta),
                unit: 'XLM',
                sub: `${g.netDelta < 0 ? 'short' : 'long'} the underlying · the same directional exposure as holding ${signed(g.netDelta, 0)} XLM`,
              },
              {
                label: 'Net vega',
                value: signed(g.netVega / 100),
                unit: 'USD / vol pt',
                sub: `${g.netVega < 0 ? 'short' : 'long'} volatility · P&L per 1 point of implied vol`,
              },
            ]}
          />
          {g.pricedPositions < portfolio.counts.open && (
            <div className="font-mono text-tiny text-brand mt-4">
              priced {g.pricedPositions} of {portfolio.counts.open} open
              positions — the rest could not be priced and are not in these
              totals
            </div>
          )}
        </>
      ) : (
        <div className="font-mono text-caption text-ink-2">Not shown — {absence}.</div>
      )}
    </Panel>
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
    <Panel
      title="Asset exposure"
      note="calls lock XLM, puts lock cash — separate tokens, so there is no combined total"
    >
      <StatStrip
        className="mb-6"
        stats={[
          {
            label: 'Locked in calls',
            value: amount(portfolio.collateral.callXlm),
            unit: 'XLM',
          },
          {
            label: 'Locked in puts',
            value: `$${amount(portfolio.collateral.putUsd)}`,
          },
        ]}
      />

      <div className="scroll-slim overflow-x-auto">
        <div className="min-w-[560px]">
          <div className="label grid grid-cols-[1.1fr_0.9fr_0.9fr_0.8fr_1.1fr] gap-3 pb-2">
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
            // Same distinction the position rows make: a bucket whose expiry
            // is past the oracle's history window is not waiting for anything.
            const closed = due && !withinOracleWindow(new Date(b.expiryIso))

            return (
              <div
                key={b.expiryIso}
                className="grid grid-cols-[1.1fr_0.9fr_0.9fr_0.8fr_1.1fr] gap-3 py-2.5 border-b border-line-light last:border-0 items-baseline"
              >
                <div>
                  <div className="font-mono text-caption text-ink">{b.expiryLabel}</div>
                  <div
                    className={`font-mono text-tiny ${closed ? 'text-accent-red' : 'text-ink-2'}`}
                  >
                    {closed
                      ? 'window closed'
                      : due
                        ? 'awaiting settlement'
                        : `in ${Math.ceil(b.daysToExpiry)}d · ${b.positions} position${b.positions === 1 ? '' : 's'}`}
                  </div>
                </div>
                <div className="num text-caption text-ink text-right">
                  {b.callCollateralXlm > 0 ? amount(b.callCollateralXlm) : '—'}
                </div>
                <div className="num text-caption text-ink text-right">
                  {b.putCollateralUsd > 0 ? amount(b.putCollateralUsd) : '—'}
                </div>
                <div className="num text-caption text-accent-green text-right">
                  ${amount(b.premiumUsd, 4)}
                </div>
                <div className="num text-tiny text-ink-2 text-right">
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
        <div className="font-mono text-tiny text-ink-2 mt-3">
          Vault load is every writer&apos;s collateral at that expiry against the
          contract&apos;s own per-expiry cap, read from contract state — not your
          share.
        </div>
      )}
    </Panel>
  )
}

/** Token-tagged, because which token arrived is the point of the whole line. */
function payoutAmount(payout: { amount: number; asset: 'XLM' | 'LUSD' }): string {
  const digits = payout.asset === 'XLM' ? 2 : 4
  return `${payout.amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  })} ${payout.asset}`
}

/**
 * What settlement did, on the position it did it to.
 *
 * A settled covered call is the one place this product can hand back a
 * different token than it took, and the dashboard used to render that as
 * "settled: yes" — indistinguishable, to the writer looking for their XLM,
 * from the money having gone missing. It had not: the contract pays at
 * settlement, straight to the writer's wallet, in the same transaction that
 * closes the position. There is nothing to claim, so the honest fix is to say
 * what was paid and point at the transaction that paid it.
 *
 * The amount comes from the API, which computes it with the contract's own
 * integer arithmetic. The price and the hash come from the settle event and so
 * go missing once the RPC's retention window rolls past them — an old
 * settlement therefore shows what it paid without showing where, which is a
 * smaller loss than showing nothing.
 */
function Settlement({ position }: { position: Position }) {
  const payout = position.payout
  if (!payout) return null

  const assigned = position.outcome === 'assigned'
  const isCall = position.type === 'call'
  const gaveUp = isCall ? 'XLM' : 'cash'
  const at =
    position.settlePrice != null
      ? ` at $${position.settlePrice.toFixed(4)}`
      : ''

  return (
    <div className="mt-4 pt-4 border-t border-line-light flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="font-mono text-caption text-ink-2">
        {assigned
          ? `Assigned${at} — the vault took your ${gaveUp} and paid you`
          : `Not assigned${at} — your collateral came back as`}
      </span>
      <span className="num text-caption text-accent-green font-semibold">
        {payoutAmount(payout)}
      </span>
      <span className="font-mono text-caption text-ink-2">
        , already in this wallet. Nothing to claim.
      </span>
      {position.settleHash && (
        <a
          href={`https://stellarchain.io/tx/${position.settleHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-caption flex items-center gap-1 text-ink-2 hover:text-ink"
          title="View the settlement transaction"
        >
          settlement {position.settleHash.slice(0, 8)}…
          <ExternalLink size={11} />
        </a>
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
    <div className="max-w-content mx-auto px-6 py-10">
      {/* Title on the left, the one action this page leads to on the right —
          from here, the only thing to do next is open another position. */}
      <PageHeader
        path="~/dashboard"
        title="Your positions"
        action={
          <Link href="/earn" className="btn btn-primary press">
            Earn upfront
            <ArrowRight size={14} />
          </Link>
        }
      />

      {toast && (
        <div
          className={
            'notice mb-4 ' + (toast.kind === 'ok' ? 'notice-ok' : 'notice-error')
          }
        >
          {toast.text}
        </div>
      )}

      {/* Book first, then the positions it summarises, then risk. The rail
          carries the figures you check; the main column carries the rows you
          act on. Below `lg` the rail simply stacks under it. */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.9fr_1fr] gap-4 items-start">
        <div className="space-y-4 min-w-0">
      {!connected && (
        <div className="light-card">
          <EmptyState
            icon={Wallet}
            title="Connect a wallet to see your positions."
            hint="Nothing is stored locally — positions are read from contract state, so they follow the wallet, not the browser."
            action={
              <button onClick={connect} className="btn btn-primary press">
                connect
              </button>
            }
          />
        </div>
      )}

      {connected && loading && positions.length === 0 && (
        <div className="light-card p-12 rounded-sm text-center">
          <div className="font-mono text-body text-ink-2 inline-flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" /> Loading positions…
          </div>
        </div>
      )}

      {connected && !loading && positions.length === 0 && (
        <div className="light-card">
          <EmptyState
            icon={LayoutList}
            title="No active positions yet."
            hint="Pick a strike you would be happy to sell at, and the upfront lands in your wallet the moment you deposit."
            action={
              <Link href="/earn" className="btn btn-primary press">
                go to earn
                <ArrowRight size={14} />
              </Link>
            }
          />
        </div>
      )}

      {connected && positions.length > 0 && (
        <div className="space-y-2">
          {positions.map((p) => {
            const days = daysRemaining(p.expiryIso)
            const expired = isExpired(p.expiryIso)
            // Expired, unsettled, and past the oracle's history window: no
            // runner and no stranger can close this one now. Saying "awaiting
            // settlement" about it is a promise the contract cannot keep.
            const stranded =
              expired &&
              !p.settled &&
              p.expiryIso !== null &&
              !withinOracleWindow(new Date(p.expiryIso))
            const isCall = p.type === 'call'
            const iconSrc = isCall ? '/xlm.png' : '/lusd.png'
            return (
              <div key={p.id} className="light-card card-interactive p-5">
                <div className="grid grid-cols-1 md:grid-cols-[1.3fr_1fr_1fr_1fr_auto] gap-5 items-center">
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
                      <div className="font-mono text-tiny text-ink-2">
                        strike ${(p.strikePrice ?? 0).toFixed(4)} · {p.expiryLabel}
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="label">
                      Collateral
                    </div>
                    <div className="num text-body text-ink font-semibold mt-0.5">
                      {isCall
                        ? formatXlm(p.collateralAmount)
                        : formatUsdc(p.collateralAmount)}
                    </div>
                  </div>

                  <div>
                    <div className="label">
                      Upfront
                    </div>
                    <div className="num text-body text-accent-green font-semibold mt-0.5">
                      ${p.premium.toFixed(4)}{' '}
                      {/* A missing APR is not a zero one. The premium is on
                          chain; the rate beside it never was, and printing
                          0.00% for an absent number tells a writer their
                          position earned nothing. */}
                      <span
                        className="text-ink-2 font-normal"
                        title={
                          p.apr === null
                            ? 'The rate was not recorded for this position and could not be reconstructed.'
                            : p.aprSource === 'derived'
                              ? 'Reconstructed: this premium against the underlying\u2019s close on the day the position was opened, annualized over its term.'
                              : 'Measured when the position was written, against the price the underlying had then.'
                        }
                      >
                        {p.apr === null
                          ? '(APR unknown)'
                          : `(${p.apr.toFixed(2)}% APR${p.aprSource === 'derived' ? '*' : ''})`}
                      </span>
                    </div>
                  </div>

                  <div>
                    <div className="label">
                      {p.settled
                        ? 'Settled'
                        : stranded
                          ? 'Cannot settle'
                          : expired
                            ? 'Awaiting settlement'
                            : 'Expires in'}
                    </div>
                    <div
                      className={`num text-body font-semibold mt-0.5 ${stranded ? 'text-accent-red' : 'text-ink'}`}
                      title={
                        stranded
                          ? 'The oracle keeps about a day of history. Past that it can no longer price this expiry, the contract refuses to settle without a price, and there is no admin path around it.'
                          : undefined
                      }
                    >
                      {/* "yes" was the old answer to a settled position, and it
                          was the wrong one: it confirms that something happened
                          without saying what, and the two things that can happen
                          pay out in different tokens. */}
                      {p.settled
                        ? (p.outcome ?? 'yes')
                        : stranded
                          ? 'oracle window closed'
                          : expired
                            ? 'now'
                            : `${days}d`}
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
                        className={`font-mono text-tiny ${stranded ? 'text-accent-red' : 'text-ink-2'}`}
                        title={
                          stranded
                            ? 'Settlement is priced at the oracle\u2019s reading for the expiry timestamp, and that reading has been pruned. The collateral stays escrowed.'
                            : 'Settled by the contract against the oracle price at expiry. Anyone can trigger it; a scheduled runner does.'
                        }
                      >
                        {stranded ? 'collateral stuck' : 'settles on chain'}
                      </span>
                    )}
                    <a
                      href={`https://stellarchain.io/tx/${p.depositHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-caption flex items-center gap-1 text-ink-2 hover:text-ink"
                      title="View deposit on explorer"
                    >
                      {p.depositHash.slice(0, 8)}…
                      <ExternalLink size={11} />
                    </a>
                  </div>
                </div>

                {p.settled && p.payout && <Settlement position={p} />}
              </div>
            )
          })}
        </div>
      )}

          {connected && positions.some((p) => p.aprSource === 'derived') && (
            <div className="font-mono text-tiny text-ink-2">
              * Rate reconstructed from the premium the contract paid and the
              underlying&apos;s close on the day the position opened. Positions
              written before the vault recorded its own rate have no other
              record of one.
            </div>
          )}

          {connected && portfolio && positions.length > 0 && (
            <ExposurePanel portfolio={portfolio} />
          )}

          {/* Live on-chain event feed — public, streamed from the ledger via
              Soroban RPC getEvents (the contract's own deposit/settle/fund
              events). */}
          <OnChainActivity />
        </div>

        {/* The rail: what your book adds up to, and what it risks. */}
        <aside className="space-y-4 lg:sticky lg:top-24">
          {connected && positions.length > 0 && (
            <Panel title="Your book">
              <StatStrip
                stack
                stats={[
                  {
                    label: 'Open positions',
                    value: positions.filter((p) => !p.settled).length,
                    sub: `${positions.length} written in total`,
                  },
                  {
                    label: 'Upfront earned',
                    value: `$${totalPremium.toFixed(2)}`,
                    tone: 'green',
                    sub: 'paid at deposit, yours in every outcome',
                  },
                  {
                    label: 'Notional',
                    value: `$${totalNotional.toFixed(2)}`,
                    sub: 'value assigned if every position is called',
                  },
                ]}
              />
            </Panel>
          )}

          {connected && portfolio && positions.length > 0 && (
            <RiskPanel portfolio={portfolio} />
          )}

          <Panel title="Earn more">
            <p className="font-mono text-caption text-ink-2 mb-4">
              Three expiries are open at a time. Each one carries its own
              capacity and its own per-wallet allowance.
            </p>
            <Link href="/earn" className="btn btn-ghost press w-full">
              Open a position
              <ArrowRight size={14} />
            </Link>
          </Panel>
        </aside>
      </div>
    </div>
  )
}
