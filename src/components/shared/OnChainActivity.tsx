'use client'
import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { useContractEvents, type VaultEvent } from '@/hooks/useContractEvents'
import { Pager } from '@/components/shared/Pager'

// Five rows at a time. The feed is a thing you scan, not a wall you scroll
// past on the way to the rest of the page.
const PAGE_SIZE = 5

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** Token-tagged: which token arrived is the point of a settlement row. */
function amountOf(payout: { amount: number; asset: 'XLM' | 'LUSD' }): string {
  return `${payout.amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: payout.asset === 'XLM' ? 2 : 4,
  })} ${payout.asset}`
}

/** The collateral an assignment took, in the unit it was escrowed in. */
function collateralOf(e: VaultEvent): string {
  const n = (e.releasedAmount ?? 0).toLocaleString('en-US', {
    maximumFractionDigits: 2,
  })
  return e.side === 'put' ? `${n} LUSD` : `${n} XLM`
}

function label(e: VaultEvent): { tag: string; tone: string; text: string } {
  // Positions written on the retired distributor rail carry no contract id.
  // "#null" is not a position number, so those rows lead with the collateral.
  const ref = e.id ? `#${e.id} · ` : ''

  if (e.kind === 'deposit') {
    // A call escrows the underlying, a put escrows cash — label each in the
    // unit it was actually posted in.
    const put = e.side === 'put'
    const collateral = put
      ? `$${(e.amount ?? 0).toLocaleString()}`
      : `${(e.amount ?? 0).toLocaleString()} XLM`
    return {
      tag: put ? 'put' : 'call',
      tone: 'text-accent-green',
      text: `${ref}${collateral} @ $${(e.strikeUsd ?? 0).toFixed(4)} · +$${(e.premiumCash ?? 0).toFixed(2)}`,
    }
  }
  if (e.kind === 'settle') {
    const assigned = e.outcome === 'assigned'
    // Settlement is the only moment this vault hands back a different token
    // than it took, so the row says what moved rather than only how it
    // resolved. Without the amounts, "assigned" is a verdict with no payment
    // attached and reads like nothing arrived.
    const moved = e.payout
      ? assigned
        ? ` · ${collateralOf(e)} → ${amountOf(e.payout)}`
        : ` · ${amountOf(e.payout)} returned`
      : ''
    return {
      tag: 'settle',
      tone: assigned ? 'text-brand' : 'text-ink',
      text: `${ref}${e.outcome} @ $${(e.priceUsd ?? 0).toFixed(4)}${moved}`,
    }
  }
  const underlying = e.pool === 'underlying'
  return {
    tag: 'fund',
    tone: 'text-ink-2',
    text: underlying
      ? `inventory +${(e.amountCash ?? 0).toLocaleString()} XLM`
      : `pool +$${(e.amountCash ?? 0).toLocaleString()}`,
  }
}

// One wallet's activity, or the vault's: the contract's own events (deposit /
// settle / fund) streamed from the ledger via Soroban RPC getEvents, backfilled
// from the deposit mirror for anything older than the RPC's ~7-day window.
//
// Pass an address and the feed is that wallet's — which is what the dashboard
// wants. Unscoped it showed every writer's settlements under a heading about
// your positions, with nothing to say whose was whose; the first question it
// got asked was what somebody else's assignment had to do with anything.
//
// Without the mirror backfill this panel went blank on a vault whose last
// deposit was a fortnight old — three open positions on the same screen, and a
// feed saying nothing had ever happened. Every row still names a real
// transaction and links to it; the mirror only supplies the ones the ledger's
// event window dropped.
export function OnChainActivity({ address }: { address?: string | null }) {
  const { events, loading } = useContractEvents(address)
  const mirrored = events.filter((e) => e.source === 'mirror').length
  const mine = !!address

  const [page, setPage] = useState(0)
  const pageCount = Math.ceil(events.length / PAGE_SIZE)
  // A poll that shortens the feed must not strand the reader on a page that no
  // longer exists.
  useEffect(() => {
    setPage((p) => Math.min(p, Math.max(0, pageCount - 1)))
  }, [pageCount])
  const shown = events.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)

  return (
    <div className="mt-10">
      <div className="mb-3 flex items-center justify-between">
        <div className="font-mono text-caption text-ink-2">
          {mine ? '~/your activity' : '~/on-chain activity'}
        </div>
        <div
          className="font-mono text-tiny text-ink-2 flex items-center gap-1.5"
          title={
            mirrored > 0
              ? 'Soroban RPC keeps about seven days of contract events. Older deposits are read from this app\u2019s own record of them; each still links to its transaction.'
              : 'Streamed from the ledger via Soroban RPC getEvents.'
          }
        >
          {mine ? 'this wallet · ' : ''}
          {mirrored > 0 ? 'soroban events · mirrored history' : 'live · soroban events'}
        </div>
      </div>

      <div className="light-card divide-y divide-line-light">
        {loading && events.length === 0 && (
          <div className="p-5 font-mono text-caption text-ink-2">
            Reading ledger events…
          </div>
        )}

        {!loading && events.length === 0 && (
          <div className="p-5 font-mono text-caption text-ink-2">
            {mine
              ? 'Nothing yet — this wallet has written no positions the ledger or our record still holds.'
              : 'Nothing yet — no ledger events in the lookback window and no deposits on record.'}
          </div>
        )}

        {shown.map((e, i) => {
          const l = label(e)
          return (
            <div
              key={`${e.txHash ?? e.ledger}-${e.kind}-${e.id}-${i}`}
              className="px-5 py-3 flex items-center gap-3 font-mono text-caption"
            >
              <span
                className={`shrink-0 uppercase tracking-wider text-micro ${l.tone}`}
                title={
                  e.source === 'mirror'
                    ? 'Older than the RPC\u2019s event window — read from this app\u2019s record of the deposit.'
                    : 'Read from the ledger.'
                }
              >
                {l.tag}
                {e.source === 'mirror' && (
                  <span className="text-ink-faint">*</span>
                )}
              </span>
              <span className="num text-ink truncate flex-1">{l.text}</span>
              <span className="text-ink-2 shrink-0">{timeAgo(e.at)}</span>
              {e.txHash && (
                <a
                  href={`https://stellarchain.io/tx/${e.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ink-2 hover:text-ink shrink-0"
                  title="View on explorer"
                >
                  <ExternalLink size={11} />
                </a>
              )}
            </div>
          )
        })}
      </div>

      <Pager
        className="mt-3"
        page={page}
        pageCount={pageCount}
        onChange={setPage}
      />
    </div>
  )
}
