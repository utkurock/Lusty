'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Banknote, Loader2, ShieldCheck } from 'lucide-react'
import { ANCHOR_ASSET_CODE, FIAT_CODE } from '@/lib/anchor/config'
import { LUSD_CODE } from '@/lib/lusd'
import { describe, useAnchorConfig, useTransactionPoll } from '@/lib/anchor/useAnchor'
import { fetchPrice, fetchQuote } from '@/lib/anchor/sep38'
import { startDeposit, simulateBankTransfer } from '@/lib/anchor/sep6'
import { buildTrustlineTx, readAssetState, submitFailureReason, submitSigned } from '@/lib/anchor/chain'
import { useWalletContext } from '@/providers/WalletProvider'
import type { AnchorPrice, AnchorSession, DepositInstructions } from '@/lib/anchor/types'
import { CopyValue } from './CopyValue'
import { TransactionSummary } from './TransactionSummary'

/**
 * What the field suggests before the anchor has been asked.
 *
 * The real limits come back on the deposit itself, in lira, and are adopted
 * from there. (SEP-6 /info states its min and max in the asset, not the fiat
 * the user is typing, so it cannot answer this question.)
 */
const ASSUMED_LIMITS = { min: 50, max: 3000 }

export function DepositFlow({ session, address }: { session: AnchorSession; address: string }) {
  const { currency } = useAnchorConfig()
  const { signTransaction } = useWalletContext()

  const [amount, setAmount] = useState('200')
  const [limits, setLimits] = useState(ASSUMED_LIMITS)
  const [price, setPrice] = useState<AnchorPrice | null>(null)
  const [pricing, setPricing] = useState(false)
  const [priceError, setPriceError] = useState<string | null>(null)

  const [trusted, setTrusted] = useState<boolean | null>(null)
  const [trusting, setTrusting] = useState(false)

  const [order, setOrder] = useState<DepositInstructions | null>(null)
  const [starting, setStarting] = useState(false)
  const [simulating, setSimulating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { tx, refresh } = useTransactionPoll(order?.id ?? null, session.token)

  useEffect(() => {
    if (!currency) return
    readAssetState(address, currency)
      .then(s => setTrusted(s.trusted))
      .catch(() => setTrusted(null))
  }, [address, currency, tx?.status])

  // An indicative price while the user types. Debounced, because every
  // keystroke would otherwise ask an oracle-backed endpoint for a number the
  // user is still in the middle of choosing.
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    const value = Number(amount)
    if (!value || value <= 0) {
      setPrice(null)
      setPriceError(null)
      return
    }
    setPricing(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      fetchPrice('on', Number(value).toFixed(2), session.token)
        .then(p => {
          setPrice(p)
          setPriceError(null)
        })
        .catch(e => {
          setPrice(null)
          setPriceError(describe(e))
        })
        .finally(() => setPricing(false))
    }, 400)
    return () => clearTimeout(timer.current)
  }, [amount, session.token])

  const addTrustline = useCallback(async () => {
    if (!currency) return
    setError(null)
    setTrusting(true)
    try {
      const xdr = await buildTrustlineTx(address, currency)
      await submitSigned(await signTransaction(xdr))
      setTrusted(true)
    } catch (e) {
      setError(submitFailureReason(e))
    } finally {
      setTrusting(false)
    }
  }, [address, currency, signTransaction])

  const start = useCallback(async () => {
    setError(null)
    setStarting(true)
    try {
      const fiat = Number(amount).toFixed(2)
      // The quote is taken first and passed in: it is what turns the number on
      // this screen into the number the user is actually paid, rather than
      // whatever the rate happens to be when the lira lands.
      let quoteId: string | undefined
      try {
        quoteId = (await fetchQuote('on', fiat, session.token)).id
      } catch {
        // An anchor without a quote server still ramps; it just prices later.
        quoteId = undefined
      }
      const started = await startDeposit({ account: address, amount: fiat, token: session.token, quoteId })
      if (started.minAmount || started.maxAmount) {
        setLimits({ min: started.minAmount ?? limits.min, max: started.maxAmount ?? limits.max })
      }
      setOrder(started)
    } catch (e) {
      setError(describe(e))
    } finally {
      setStarting(false)
    }
  }, [address, amount, session.token, limits.min, limits.max])

  const playBank = useCallback(async () => {
    if (!order) return
    setError(null)
    setSimulating(true)
    try {
      await simulateBankTransfer(order.id, Number(amount).toFixed(2))
      refresh()
    } catch (e) {
      setError(describe(e))
    } finally {
      setSimulating(false)
    }
  }, [order, amount, refresh])

  const instructions = order?.instructions ?? tx?.instructions
  const waitingForBank = tx ? tx.status === 'pending_user_transfer_start' : Boolean(order)
  const outOfRange = useMemo(() => {
    const v = Number(amount)
    return v > 0 && (v < limits.min || v > limits.max)
  }, [amount, limits])

  if (order) {
    return (
      <div className="space-y-6">
        <div className="light-card p-6">
          <h2 className="font-display text-head-sm text-ink">Send the lira</h2>
          <p className="font-mono text-caption text-ink-2 mt-2 max-w-xl">
            Transfer {Number(amount).toFixed(2)} {FIAT_CODE} to the account below and write the
            reference in the description. The reference is what tells the anchor the money is
            yours; a transfer without it arrives unattributed.
          </p>

          <div className="grid sm:grid-cols-2 gap-4 mt-5">
            {instructions?.bank_name && (
              <CopyValue label="bank" value={instructions.bank_name.value} />
            )}
            {instructions?.bank_account_number && (
              <CopyValue
                label="iban"
                value={instructions.bank_account_number.value}
                hint={instructions.bank_account_number.description}
                code
              />
            )}
            {instructions?.external_transfer_memo && (
              <CopyValue
                label="reference (açıklama)"
                value={instructions.external_transfer_memo.value}
                hint={instructions.external_transfer_memo.description}
                code
              />
            )}
            <CopyValue label="paid to" value={address} code hint={`Where the ${ANCHOR_ASSET_CODE} will land.`} />
          </div>
        </div>

        {waitingForBank && (
          <div className="light-card p-6">
            <div className="flex items-center gap-2">
              <Banknote size={16} className="text-brand" />
              <h2 className="font-display text-head-sm text-ink">Play the bank</h2>
            </div>
            <p className="font-mono text-caption text-ink-2 mt-2 max-w-xl">
              This is the one step with no counterpart on a real anchor. There, your transfer
              arrives and the anchor notices. Here there is no bank, so nothing arrives until you
              say it did.
            </p>
            <button onClick={playBank} disabled={simulating} className="btn btn-primary press mt-4">
              {simulating && <Loader2 size={16} className="animate-spin" />}
              simulate the incoming transfer
            </button>
          </div>
        )}

        {trusted === false && (
          <div className="notice notice-warn">
            This account still has no {ANCHOR_ASSET_CODE} trustline, so the anchor will hold the
            payment as pending_trust until it does.
            <button
              onClick={addTrustline}
              disabled={trusting}
              className="press rounded-sm underline ml-1"
            >
              {trusting ? 'adding…' : 'add it now'}
            </button>
          </div>
        )}

        {tx && <TransactionSummary tx={tx} />}

        {/* The ramp's job ends when the asset lands. This says what it is good
            for next, because "completed" on its own leaves the user holding an
            asset the rest of the venue does not take. */}
        {tx?.status === 'completed' && (
          <div className="light-card p-5">
            <h3 className="font-display text-head-sm text-ink">
              Put it to work
            </h3>
            <p className="font-mono text-caption text-ink-2 mt-2 max-w-xl">
              The {ANCHOR_ASSET_CODE} is in your wallet. The vault escrows {LUSD_CODE} instead, so
              writing a cash-secured put with it takes one more step: a one-for-one crossing, no
              spread, and then the books on Earn are open to you.
            </p>
            <Link href="/anchor/convert" className="btn btn-primary press mt-4">
              convert to {LUSD_CODE} <ArrowRight size={16} />
            </Link>
          </div>
        )}

        {error && <div className="notice notice-error">{error}</div>}

        <button
          onClick={() => {
            setOrder(null)
            setError(null)
          }}
          className="btn btn-ghost press"
        >
          start another
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-xl">
      <div className="light-card p-6">
        <label className="label" htmlFor="try-amount">
          you send
        </label>
        <div className="flex items-baseline gap-3 mt-2">
          <input
            id="try-amount"
            inputMode="decimal"
            value={amount}
            onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            className="num text-head-lg bg-transparent text-ink w-full outline-none"
            placeholder="0.00"
          />
          <span className="font-mono text-head-sm text-ink-2">{FIAT_CODE}</span>
        </div>
        <div className="font-mono text-caption text-ink-2 mt-1">
          {limits.min} – {limits.max} {FIAT_CODE} per deposit
        </div>

        <div className="mt-5 space-y-0">
          <Row label="you receive">
            {pricing && !price ? (
              <span className="skeleton w-24 h-4" />
            ) : price ? (
              `${price.buyAmount} ${ANCHOR_ASSET_CODE}`
            ) : (
              '—'
            )}
          </Row>
          <Row label="rate">
            {price ? `${Number(price.totalPrice).toFixed(4)} ${FIAT_CODE} / ${ANCHOR_ASSET_CODE}` : '—'}
          </Row>
          <Row label="fee">
            {price ? `${price.fee.total} ${FIAT_CODE} · 50 bps spread` : '—'}
          </Row>
        </div>
      </div>

      {priceError && <div className="notice notice-error">{priceError}</div>}
      {outOfRange && !priceError && (
        <div className="notice notice-warn">
          The anchor takes {limits.min} to {limits.max} {FIAT_CODE} per deposit.
        </div>
      )}

      {trusted === false && (
        <div className="light-card p-5">
          <div className="flex items-center gap-2">
            <ShieldCheck size={16} className="text-brand" />
            <h3 className="font-display text-head-sm text-ink">Open a trustline first</h3>
          </div>
          <p className="font-mono text-caption text-ink-2 mt-2">
            A Stellar account can only hold an asset it has opted into. Without a trustline the
            anchor has nowhere to pay and the deposit waits. It costs 0.5 XLM of reserve, refunded
            if you ever close the line.
          </p>
          <button onClick={addTrustline} disabled={trusting} className="btn btn-ghost press mt-4">
            {trusting && <Loader2 size={16} className="animate-spin" />}
            add the {ANCHOR_ASSET_CODE} trustline
          </button>
        </div>
      )}

      <button
        onClick={start}
        disabled={starting || !price || outOfRange}
        className="btn btn-primary press"
      >
        {starting && <Loader2 size={16} className="animate-spin" />}
        get the bank details
      </button>

      {error && <div className="notice notice-error">{error}</div>}
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
