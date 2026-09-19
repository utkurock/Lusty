'use client'

import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useWalletContext } from '@/providers/WalletProvider'
import { AnchorCrossings } from '@/components/anchor/AnchorCrossings'
import { SessionGate } from '@/components/anchor/SessionGate'
import { TransactionSummary } from '@/components/anchor/TransactionSummary'
import { fetchTransactions } from '@/lib/anchor/sep6'
import { describe } from '@/lib/anchor/useAnchor'
import type { AnchorSession, AnchorTransaction } from '@/lib/anchor/types'

export default function AnchorActivityPage() {
  return (
    <div className="space-y-6">
      <header>
        <div className="font-mono text-caption text-brand">~/anchor/activity</div>
        <h1 className="font-display text-head-lg text-ink mt-1">Your ramps</h1>
        <p className="font-mono text-caption text-ink-2 mt-1.5 max-w-xl">
          Every deposit and withdrawal this key has opened with the anchor, as the anchor records
          them. Nothing here is stored by Lusty.
        </p>
      </header>

      <Crossings />

      <SessionGate intent="Signing in lets the anchor list the orders it holds for your key.">
        {session => <History session={session} />}
      </SessionGate>
    </div>
  )
}

/** The bridge's own history needs no anchor session: it is our record, not theirs. */
function Crossings() {
  const { address } = useWalletContext()
  return <AnchorCrossings address={address} />
}

function History({ session }: { session: AnchorSession }) {
  const [rows, setRows] = useState<AnchorTransaction[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let live = true
    fetchTransactions(session.token)
      .then(r => live && setRows(r))
      .catch(e => live && setError(describe(e)))
    return () => {
      live = false
    }
  }, [session.token, nonce])

  if (error) return <div className="notice notice-error">{error}</div>
  if (!rows) return <div className="skeleton h-24 w-full" />
  if (rows.length === 0)
    return (
      <div className="notice notice-quiet">
        Nothing yet. An on-ramp or an off-ramp will show up here the moment it is opened.
      </div>
    )

  return (
    <div className="space-y-4">
      <button
        onClick={() => setNonce(n => n + 1)}
        className="press rounded-sm font-mono text-caption text-ink-2 hover:text-ink inline-flex items-center gap-1.5"
      >
        <RefreshCw size={12} /> refresh
      </button>
      {rows.map(tx => (
        <TransactionSummary key={tx.id} tx={tx} />
      ))}
    </div>
  )
}
