'use client'
import { ExternalLink } from 'lucide-react'
import { useContractEvents, type VaultEvent } from '@/hooks/useContractEvents'

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function label(e: VaultEvent): { tag: string; tone: string; text: string } {
  if (e.kind === 'deposit') {
    return {
      tag: 'deposit',
      tone: 'text-[#22c55e]',
      text: `#${e.id} · ${(e.amountXlm ?? 0).toLocaleString()} XLM @ $${(e.strikeUsd ?? 0).toFixed(4)} · +$${(e.premiumCash ?? 0).toFixed(2)}`,
    }
  }
  if (e.kind === 'settle') {
    const assigned = e.outcome === 'assigned'
    return {
      tag: 'settle',
      tone: assigned ? 'text-[#eab308]' : 'text-ink',
      text: `#${e.id} · ${e.outcome} @ $${(e.priceUsd ?? 0).toFixed(4)}`,
    }
  }
  return {
    tag: 'fund',
    tone: 'text-ink-2',
    text: `pool +$${(e.amountCash ?? 0).toLocaleString()}`,
  }
}

// Live feed of the vault contract's on-chain events (deposit / settle / fund),
// streamed straight from the ledger via Soroban RPC getEvents. This closes the
// loop the contract opens with env.events().publish(...): emit on-chain →
// stream → render.
export function OnChainActivity() {
  const { events, loading } = useContractEvents()

  return (
    <div className="mt-10">
      <div className="mb-3 flex items-center justify-between">
        <div className="font-mono text-xs text-ink-2">~/on-chain activity</div>
        <div className="font-mono text-[11px] text-ink-2 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e] animate-pulse" />
          live · soroban events
        </div>
      </div>

      <div className="light-card rounded-sm divide-y divide-line">
        {loading && events.length === 0 && (
          <div className="p-5 font-mono text-xs text-ink-2">
            Reading ledger events…
          </div>
        )}

        {!loading && events.length === 0 && (
          <div className="p-5 font-mono text-xs text-ink-2">
            No recent on-chain events in the lookback window.
          </div>
        )}

        {events.map((e, i) => {
          const l = label(e)
          return (
            <div
              key={`${e.txHash ?? e.ledger}-${e.kind}-${e.id}-${i}`}
              className="px-5 py-3 flex items-center gap-3 font-mono text-xs"
            >
              <span
                className={`shrink-0 uppercase tracking-wider text-[10px] ${l.tone}`}
              >
                {l.tag}
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
    </div>
  )
}
