'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, ExternalLink } from 'lucide-react'
import { Panel } from '@/components/shared/Panel'
import { EXPLORER_TX } from '@/lib/anchor/chain'

interface Crossing {
  amount: number
  from: string
  to: string | null
  direction: string | null
  fundingHash: string | null
  payoutHash: string | null
  at: string
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/**
 * Where the collateral came from.
 *
 * A position opened with bridged cash looks, in the vault's own feed, exactly
 * like one opened with cash that was always there — the contract sees an amount
 * of the token it escrows and nothing about its history. This panel is that
 * missing half: the payment that left the wallet in one dollar and the payment
 * that came back in the other, named as the single movement they were, with
 * both hashes to check.
 *
 * It renders nothing at all until there is a crossing to show, so a wallet that
 * never used the ramp never learns this panel exists.
 */
export function AnchorCrossings({ address }: { address: string | null }) {
  const [rows, setRows] = useState<Crossing[] | null>(null)

  useEffect(() => {
    if (!address) {
      setRows(null)
      return
    }
    let live = true
    fetch(`/api/anchor/crossings?address=${address}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(body => live && setRows(body?.crossings ?? []))
      .catch(() => live && setRows([]))
    return () => {
      live = false
    }
  }, [address])

  if (!address || !rows || rows.length === 0) return null

  return (
    <Panel
      title="Ramp crossings"
      note={
        <Link href="/anchor" className="press rounded-sm hover:text-ink inline-flex items-center gap-1">
          anchor <ArrowRight size={12} />
        </Link>
      }
    >
      <div className="space-y-0">
        {rows.map(row => (
          <div
            key={`${row.fundingHash}-${row.at}`}
            className="dashed-row flex items-baseline justify-between gap-4 py-2.5 last:border-0"
          >
            <div className="min-w-0">
              <div className="num text-body text-ink">
                {row.amount.toLocaleString('en-US', { maximumFractionDigits: 4 })} {row.from}
                {row.to ? ` → ${row.amount.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${row.to}` : ''}
              </div>
              <div className="font-mono text-caption text-ink-2">
                {row.direction === 'cash_to_anchor' ? 'out to the ramp' : 'into the vault'} ·{' '}
                {timeAgo(row.at)}
              </div>
            </div>

            <div className="flex gap-3 font-mono text-caption shrink-0">
              {row.fundingHash && (
                <a
                  href={EXPLORER_TX(row.fundingHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="press rounded-sm text-ink-2 hover:text-ink inline-flex items-center gap-1"
                >
                  sent <ExternalLink size={11} />
                </a>
              )}
              {row.payoutHash && (
                <a
                  href={EXPLORER_TX(row.payoutHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="press rounded-sm text-brand inline-flex items-center gap-1"
                >
                  received <ExternalLink size={11} />
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  )
}
