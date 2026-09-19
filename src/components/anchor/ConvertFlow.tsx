'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { useWalletContext } from '@/providers/WalletProvider'
import { EXPLORER_TX, submitFailureReason, submitSigned } from '@/lib/anchor/chain'
import {
  buildBridgePaymentTx,
  buildBridgeTrustlineTx,
  checkBridge,
  claimBridge,
  legsOf,
  readBridgeBalances,
  type BridgeDirection,
  type BridgeResult,
} from '@/lib/anchor/bridge'
import { BRIDGE_MIN_AMOUNT } from '@/lib/anchor/config'
import { describe } from '@/lib/anchor/useAnchor'
import { cn } from '@/lib/utils'

const DIRECTIONS: { key: BridgeDirection; label: string }[] = [
  { key: 'anchor_to_cash', label: 'into the vault' },
  { key: 'cash_to_anchor', label: 'out to the ramp' },
]

export function ConvertFlow() {
  const { address, connected, connect, signTransaction, syncAddress } = useWalletContext()

  const [direction, setDirection] = useState<BridgeDirection>('anchor_to_cash')
  const [amount, setAmount] = useState('10')
  const [balances, setBalances] = useState<Record<string, { trusted: boolean; balance: string }>>({})
  const [readiness, setReadiness] = useState<{ ready: boolean; reason?: string } | null>(null)
  const [checking, setChecking] = useState(false)

  const [busy, setBusy] = useState(false)
  const [trusting, setTrusting] = useState(false)
  /** The funding payment, once it is on the ledger and before it is claimed. */
  const [funding, setFunding] = useState<string | null>(null)
  const [result, setResult] = useState<BridgeResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { pays, receives } = legsOf(direction)
  const held = Number(balances[pays.code]?.balance ?? 0)
  const canReceive = balances[receives.code]?.trusted ?? true
  const value = Number(amount)
  const tooSmall = value > 0 && value < BRIDGE_MIN_AMOUNT
  const overBalance = value > held
  /* Balances and trustlines only say anything once there is an account to read
     them from. Before that they read as zero, and the button they gated was a
     "connect wallet" that could not be pressed. */
  const blocked = Boolean(address) && (overBalance || !canReceive)

  const refreshBalances = useCallback(() => {
    if (!address) return
    readBridgeBalances(address).then(setBalances).catch(() => {})
  }, [address])

  useEffect(refreshBalances, [refreshBalances, result])

  // Ask the server whether it could honour this crossing, before the user signs
  // anything. Debounced: it loads an account and touches the database.
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    if (!value || value < BRIDGE_MIN_AMOUNT) {
      setReadiness(null)
      return
    }
    setChecking(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      checkBridge(direction, value.toFixed(7))
        .then(setReadiness)
        .catch(e => setReadiness({ ready: false, reason: describe(e) }))
        .finally(() => setChecking(false))
    }, 400)
    return () => clearTimeout(timer.current)
  }, [direction, value])

  const addTrustline = useCallback(async () => {
    if (!address) return
    setError(null)
    setTrusting(true)
    try {
      await submitSigned(await signTransaction(await buildBridgeTrustlineTx(address, receives)))
      refreshBalances()
    } catch (e) {
      setError(submitFailureReason(e))
    } finally {
      setTrusting(false)
    }
  }, [address, receives, refreshBalances, signTransaction])

  /** Claim the other side of a payment that is already on the ledger. */
  const claim = useCallback(
    async (hash: string) => {
      const claimed = await claimBridge({
        address: address!,
        txHash: hash,
        direction,
        sourceAmount: Number(Number(amount).toFixed(7)),
      })
      setResult(claimed)
      setFunding(null)
    },
    [address, amount, direction]
  )

  const convert = useCallback(async () => {
    setError(null)
    setResult(null)
    if (!connected || !address) {
      await connect()
      return
    }
    setBusy(true)
    try {
      // The wallet may be on a different account than the one we remember, and
      // this payment leaves from whichever it is actually on.
      const live = await syncAddress()
      if (live && live !== address) {
        setError(
          `Your wallet is on a different account now (${live.slice(0, 4)}…${live.slice(-4)}). ` +
            'Nothing was sent — press again to convert from it.'
        )
        return
      }

      const ready = await checkBridge(direction, Number(amount).toFixed(7))
      setReadiness(ready)
      if (!ready.ready) {
        setError(ready.reason ?? 'the bridge cannot honour this right now')
        return
      }

      const xdr = await buildBridgePaymentTx({
        from: address,
        direction,
        amount: Number(amount).toFixed(7),
      })
      const hash = await submitSigned(await signTransaction(xdr))
      setFunding(hash)
      await claim(hash)
    } catch (e) {
      setError(describe(e))
    } finally {
      setBusy(false)
    }
  }, [address, amount, claim, connect, connected, direction, signTransaction, syncAddress])

  const retryClaim = useCallback(async () => {
    if (!funding) return
    setError(null)
    setBusy(true)
    try {
      await claim(funding)
    } catch (e) {
      setError(describe(e))
    } finally {
      setBusy(false)
    }
  }, [claim, funding])

  return (
    <div className="space-y-6 max-w-xl">
      <div className="inline-flex gap-1 p-1 rounded-sm bg-surface-2">
        {DIRECTIONS.map(d => (
          <button
            key={d.key}
            onClick={() => {
              setDirection(d.key)
              setResult(null)
              setError(null)
            }}
            aria-selected={direction === d.key}
            className={cn(
              'press rounded-inner px-3 py-1.5 font-mono text-caption',
              direction === d.key ? 'bg-card text-ink shadow-button' : 'text-ink-2 hover:text-ink'
            )}
          >
            {d.label}
          </button>
        ))}
      </div>

      <div className="light-card p-6">
        <div className="flex items-baseline justify-between">
          <label className="label" htmlFor="bridge-amount">
            you send
          </label>
          {address && (
            <button
              onClick={() => setAmount(String(held))}
              className="press rounded-sm font-mono text-caption text-ink-2 hover:text-ink"
            >
              balance {held.toFixed(7)} {pays.code} · use all
            </button>
          )}
        </div>
        <div className="flex items-baseline gap-3 mt-2">
          <input
            id="bridge-amount"
            inputMode="decimal"
            value={amount}
            onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            className="num text-head-lg bg-transparent text-ink w-full outline-none"
            placeholder="0.0000000"
          />
          <span className="font-mono text-head-sm text-ink-2">{pays.code}</span>
        </div>

        <div className="mt-5 space-y-0">
          <Row label="you receive">
            {value > 0 ? `${value.toFixed(7)} ${receives.code}` : '—'}
          </Row>
          <Row label="rate">1.0000000 · one for one, no spread</Row>
          <Row label="bridge">
            {checking ? (
              <span className="skeleton w-20 h-4" />
            ) : readiness?.ready ? (
              'ready'
            ) : readiness ? (
              'short'
            ) : (
              '—'
            )}
          </Row>
        </div>
      </div>

      {tooSmall && (
        <div className="notice notice-warn">
          The smallest crossing is {BRIDGE_MIN_AMOUNT} {pays.code}.
        </div>
      )}
      {overBalance && address && (
        <div className="notice notice-warn">
          This account holds {held.toFixed(7)} {pays.code}.
        </div>
      )}
      {readiness && !readiness.ready && readiness.reason && (
        <div className="notice notice-warn">{readiness.reason}</div>
      )}

      {address && !canReceive && (
        <div className="light-card p-5">
          <h3 className="font-display text-head-sm text-ink">
            Open a {receives.code} trustline first
          </h3>
          <p className="font-mono text-caption text-ink-2 mt-2">
            The bridge pays {receives.code}, and an account can only be paid an asset it has opted
            into.
          </p>
          <button onClick={addTrustline} disabled={trusting} className="btn btn-ghost press mt-4">
            {trusting && <Loader2 size={16} className="animate-spin" />}
            add the {receives.code} trustline
          </button>
        </div>
      )}

      {funding ? (
        <div className="notice notice-warn">
          Your {pays.code} payment is on the ledger but the other side has not been paid yet. Nothing
          is lost: the same payment can be claimed again.
          <div className="mt-2 flex items-center gap-4">
            <button onClick={retryClaim} disabled={busy} className="press rounded-sm underline">
              {busy ? 'claiming…' : 'claim again'}
            </button>
            <a
              href={EXPLORER_TX(funding)}
              target="_blank"
              rel="noopener noreferrer"
              className="press rounded-sm inline-flex items-center gap-1"
            >
              the payment <ExternalLink size={12} />
            </a>
          </div>
        </div>
      ) : (
        <button
          onClick={convert}
          disabled={busy || !value || tooSmall || blocked}
          className="btn btn-primary press"
        >
          {busy && <Loader2 size={16} className="animate-spin" />}
          {connected ? `convert to ${receives.code}` : 'connect wallet'}
        </button>
      )}

      {error && <div className="notice notice-error">{error}</div>}

      {result && (
        <div className="light-card p-5">
          <div className="flex items-center justify-between gap-4">
            <h3 className="font-display text-head-sm text-ink">
              {result.destAmount} {receives.code} paid
            </h3>
            <button
              onClick={refreshBalances}
              aria-label="Refresh balances"
              className="press press-sm rounded-sm p-2 text-ink-2 hover:bg-raised hover:text-ink"
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <div className="flex flex-wrap gap-4 mt-3 font-mono text-caption">
            <a
              href={EXPLORER_TX(result.payoutHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="press rounded-sm text-brand inline-flex items-center gap-1"
            >
              payout transaction <ExternalLink size={12} />
            </a>
            {direction === 'anchor_to_cash' ? (
              <Link href="/earn" className="press rounded-sm text-ink hover:text-brand inline-flex items-center gap-1">
                write a cash-secured put <ArrowRight size={12} />
              </Link>
            ) : (
              <Link href="/anchor/withdraw" className="press rounded-sm text-ink hover:text-brand inline-flex items-center gap-1">
                off-ramp it to lira <ArrowRight size={12} />
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="dashed-row flex items-baseline justify-between gap-4 py-2 last:border-0">
      <span className="label">{label}</span>
      <span className="num text-body text-ink text-right">{children}</span>
    </div>
  )
}
