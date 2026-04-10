'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useWalletContext } from '@/providers/WalletProvider'
import {
  getPositionsFor,
  markSettled,
  StoredPosition,
} from '@/lib/positions'
import { formatUsdc, formatXlm } from '@/lib/utils'
import { ExternalLink, Loader2 } from 'lucide-react'

function daysRemaining(expiryIso: string): number {
  const ms = new Date(expiryIso).getTime() - Date.now()
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)))
}

function isExpired(expiryIso: string): boolean {
  return new Date(expiryIso).getTime() <= Date.now()
}

export default function DashboardPage() {
  const { connected, connect, address } = useWalletContext()
  const [positions, setPositions] = useState<StoredPosition[]>([])
  const [claimingId, setClaimingId] = useState<string | null>(null)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const refresh = () => setPositions(getPositionsFor(address))

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])

  const totalPremium = positions.reduce((s, p) => s + p.premium, 0)
  const totalNotional = positions.reduce(
    (s, p) =>
      s + (p.type === 'call' ? p.collateralAmount * p.strikePrice : p.collateralAmount),
    0
  )

  const handleClaim = async (p: StoredPosition) => {
    setClaimingId(p.id)
    setToast(null)
    try {
      const res = await fetch('/api/vault/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: p.address,
          depositHash: p.depositHash,
          type: p.type,
          collateralAmount: p.collateralAmount,
          strikePrice: p.strikePrice,
          expiryIso: p.expiryIso,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Claim failed')
      markSettled(p.depositHash)
      refresh()
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
          <div className="font-mono text-xs text-[#6b6560]">~/dashboard</div>
          <h1 className="text-3xl font-bold text-[#1a1a1a] mt-1">Your positions</h1>
        </div>
        {connected && positions.length > 0 && (
          <div className="flex gap-6 font-mono text-xs">
            <div>
              <div className="text-[#6b6560] uppercase tracking-wider">
                Open positions
              </div>
              <div className="num text-xl font-bold text-[#1a1a1a]">
                {positions.filter((p) => !p.settled).length}
              </div>
            </div>
            <div>
              <div className="text-[#6b6560] uppercase tracking-wider">
                Upfront earned
              </div>
              <div className="num text-xl font-bold text-[#22c55e]">
                ${totalPremium.toFixed(2)}
              </div>
            </div>
            <div>
              <div className="text-[#6b6560] uppercase tracking-wider">
                Notional
              </div>
              <div className="num text-xl font-bold text-[#1a1a1a]">
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
          <div className="font-mono text-sm text-[#6b6560] mb-4">
            Connect wallet to view positions
          </div>
          <button
            onClick={connect}
            className="h-10 px-6 bg-[#1a1a1a] text-[#e8e4d9] font-mono text-sm rounded-sm hover:bg-[#2a2a2a]"
          >
            connect
          </button>
        </div>
      )}

      {connected && positions.length === 0 && (
        <div className="light-card p-12 rounded-sm text-center">
          <div className="font-mono text-sm text-[#6b6560] mb-4">
            No active positions. Start earning.
          </div>
          <Link
            href="/earn"
            className="inline-flex h-10 px-6 items-center bg-[#1a1a1a] text-[#e8e4d9] font-mono text-sm rounded-sm hover:bg-[#2a2a2a]"
          >
            go to earn
          </Link>
        </div>
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
                    <div className="font-mono font-semibold text-[#1a1a1a]">
                      {p.asset} {isCall ? 'Covered Call' : 'Cash-Secured Put'}
                    </div>
                    <div className="font-mono text-[11px] text-[#6b6560]">
                      strike ${p.strikePrice.toFixed(4)} · {p.expiryLabel}
                    </div>
                  </div>
                </div>

                <div>
                  <div className="font-mono text-[11px] uppercase text-[#6b6560] tracking-wider">
                    Collateral
                  </div>
                  <div className="num text-sm text-[#1a1a1a] font-semibold mt-0.5">
                    {isCall
                      ? formatXlm(p.collateralAmount)
                      : formatUsdc(p.collateralAmount)}
                  </div>
                </div>

                <div>
                  <div className="font-mono text-[11px] uppercase text-[#6b6560] tracking-wider">
                    Upfront
                  </div>
                  <div className="num text-sm text-[#22c55e] font-semibold mt-0.5">
                    ${p.premium.toFixed(4)}{' '}
                    <span className="text-[#6b6560] font-normal">
                      ({p.apr.toFixed(2)}% APR)
                    </span>
                  </div>
                </div>

                <div>
                  <div className="font-mono text-[11px] uppercase text-[#6b6560] tracking-wider">
                    {p.settled ? 'Settled' : expired ? 'Ready to claim' : 'Expires in'}
                  </div>
                  <div className="num text-sm text-[#1a1a1a] font-semibold mt-0.5">
                    {p.settled ? 'yes' : expired ? 'now' : `${days}d`}
                  </div>
                </div>

                <div className="flex items-center gap-3 justify-self-end">
                  {expired && !p.settled && (
                    <button
                      onClick={() => handleClaim(p)}
                      disabled={claimingId === p.id}
                      className="h-9 px-4 bg-[#eab308] text-[#1a1a1a] font-mono text-xs font-bold rounded-sm hover:bg-[#f5b938] disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2 transition"
                    >
                      {claimingId === p.id && <Loader2 size={12} className="animate-spin" />}
                      claim
                    </button>
                  )}
                  <a
                    href={`https://stellarchain.io/tx/${p.depositHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-xs flex items-center gap-1 text-[#6b6560] hover:text-[#1a1a1a]"
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
    </div>
  )
}
