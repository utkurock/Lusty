'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, Loader2, Send } from 'lucide-react'
import { ANCHOR_ASSET_CODE, FIAT_CODE } from '@/lib/anchor/config'
import { describe, useAnchorConfig, useTransactionPoll } from '@/lib/anchor/useAnchor'
import { fetchPrice, fetchQuote } from '@/lib/anchor/sep38'
import { startWithdraw } from '@/lib/anchor/sep6'
import {
  EXPLORER_TX,
  buildWithdrawPaymentTx,
  readAssetState,
  submitFailureReason,
  submitSigned,
} from '@/lib/anchor/chain'
import { useWalletContext } from '@/providers/WalletProvider'
import type { AnchorPrice, AnchorSession, WithdrawInstructions } from '@/lib/anchor/types'
import { CopyValue } from './CopyValue'
import { TransactionSummary } from './TransactionSummary'

export function WithdrawFlow({ session, address }: { session: AnchorSession; address: string }) {
  const { currency } = useAnchorConfig()
  const { signTransaction } = useWalletContext()

  const [amount, setAmount] = useState('2')
  const [balance, setBalance] = useState<string | null>(null)
  const [price, setPrice] = useState<AnchorPrice | null>(null)
  const [pricing, setPricing] = useState(false)
  const [priceError, setPriceError] = useState<string | null>(null)

  const [order, setOrder] = useState<WithdrawInstructions | null>(null)
  const [starting, setStarting] = useState(false)
  const [sending, setSending] = useState(false)
  const [hash, setHash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { tx } = useTransactionPoll(order?.id ?? null, session.token)

  useEffect(() => {
    if (!currency) return
    readAssetState(address, currency)
      .then(s => setBalance(s.trusted ? s.balance : null))
      .catch(() => setBalance(null))
  }, [address, currency, tx?.status])

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
      fetchPrice('off', value.toFixed(7), session.token)
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

  const start = useCallback(async () => {
    setError(null)
    setStarting(true)
    try {
      const size = Number(amount).toFixed(7)
      let quoteId: string | undefined
      try {
        quoteId = (await fetchQuote('off', size, session.token)).id
      } catch {
        quoteId = undefined
      }
      setOrder(await startWithdraw({ amount: size, token: session.token, quoteId }))
      setHash(null)
    } catch (e) {
      setError(describe(e))
    } finally {
      setStarting(false)
    }
  }, [amount, session.token])

  /**
   * Send the asset the anchor is waiting for.
   *
   * The memo is the order id as far as the anchor is concerned: a payment that
   * arrives without it is an anonymous credit to the treasury and settles
   * nothing, so the transaction is built here rather than handed to the user as
   * an address to paste.
   */
  const send = useCallback(async () => {
    if (!order || !currency) return
    setError(null)
    setSending(true)
    try {
      const xdr = await buildWithdrawPaymentTx({
        from: address,
        destination: order.accountId,
        amount: Number(amount).toFixed(7),
        memo: order.memo,
        memoType: order.memoType,
        currency,
      })
      setHash(await submitSigned(await signTransaction(xdr)))
    } catch (e) {
      setError(submitFailureReason(e))
    } finally {
      setSending(false)
    }
  }, [address, amount, currency, order, signTransaction])

  if (order) {
    return (
      <div className="space-y-6">
        <div className="light-card p-6">
          <h2 className="font-display text-head-sm text-ink">
            Send {Number(amount).toFixed(7)} {ANCHOR_ASSET_CODE}
          </h2>
          <p className="font-mono text-caption text-ink-2 mt-2 max-w-xl">
            The anchor is watching its treasury for a payment carrying this memo. Sending from here
            attaches it for you; the details are below if you would rather pay from somewhere else.
          </p>

          <div className="grid sm:grid-cols-2 gap-4 mt-5">
            <CopyValue label="destination" value={order.accountId} code />
            <CopyValue
              label={`memo (${order.memoType})`}
              value={order.memo}
              hint="Without this memo the payment cannot be matched to your withdrawal."
              code
            />
          </div>

          {!hash ? (
            <button onClick={send} disabled={sending} className="btn btn-primary press mt-5">
              {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              send from my wallet
            </button>
          ) : (
            <a
              href={EXPLORER_TX(hash)}
              target="_blank"
              rel="noopener noreferrer"
              className="press rounded-sm font-mono text-caption text-brand inline-flex items-center gap-1 mt-5"
            >
              payment sent · view on explorer <ExternalLink size={12} />
            </a>
          )}
        </div>

        {order.extraInfo?.message && <div className="notice notice-quiet">{order.extraInfo.message}</div>}
        {tx && <TransactionSummary tx={tx} />}
        {error && <div className="notice notice-error">{error}</div>}

        <button
          onClick={() => {
            setOrder(null)
            setHash(null)
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
        <div className="flex items-baseline justify-between">
          <label className="label" htmlFor="usdc-amount">
            you send
          </label>
          {balance !== null && (
            <button
              onClick={() => setAmount(balance)}
              className="press rounded-sm font-mono text-caption text-ink-2 hover:text-ink"
            >
              balance {Number(balance).toFixed(7)} · use all
            </button>
          )}
        </div>
        <div className="flex items-baseline gap-3 mt-2">
          <input
            id="usdc-amount"
            inputMode="decimal"
            value={amount}
            onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            className="num text-head-lg bg-transparent text-ink w-full outline-none"
            placeholder="0.0000000"
          />
          <span className="font-mono text-head-sm text-ink-2">{ANCHOR_ASSET_CODE}</span>
        </div>

        <div className="mt-5 space-y-0">
          <Row label="you receive">
            {pricing && !price ? (
              <span className="skeleton w-24 h-4" />
            ) : price ? (
              `${price.buyAmount} ${FIAT_CODE}`
            ) : (
              '—'
            )}
          </Row>
          <Row label="rate">
            {price
              ? `${(1 / Number(price.totalPrice)).toFixed(4)} ${FIAT_CODE} / ${ANCHOR_ASSET_CODE}`
              : '—'}
          </Row>
          <Row label="fee">
            {price ? `${price.fee.total} ${ANCHOR_ASSET_CODE} · 50 bps spread` : '—'}
          </Row>
        </div>
      </div>

      {priceError && <div className="notice notice-error">{priceError}</div>}
      {balance === null && (
        <div className="notice notice-warn">
          This account holds no {ANCHOR_ASSET_CODE} from this issuer. Run an on-ramp first, or send
          some to it.
        </div>
      )}

      <button onClick={start} disabled={starting || !price} className="btn btn-primary press">
        {starting && <Loader2 size={16} className="animate-spin" />}
        get the payment details
      </button>

      {error && <div className="notice notice-error">{error}</div>}

      <p className="font-mono text-caption text-ink-2">
        The lira is paid to the IBAN the anchor holds for your key. In this sandbox that IBAN is
        generated for you and the transfer is simulated; on a real anchor it is the one you gave it
        during KYC.
      </p>
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
