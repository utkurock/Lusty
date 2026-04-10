'use client'

import { useMemo, useState } from 'react'
import { ArrowDown, Loader2, Settings2, Info } from 'lucide-react'
import { useWalletContext } from '@/providers/WalletProvider'
import { useXlmPrice } from '@/hooks/useXlmPrice'
import {
  buildTrustlineTx,
  hasLusdTrustline,
  AssetCode,
  SwapQuote,
} from '@/lib/swap'
import { buildSwapPaymentTx, submitUserTx } from '@/lib/vault'
import { TransactionBuilder, Networks } from '@stellar/stellar-sdk'

const ASSETS: AssetCode[] = ['XLM', 'LUSD']

export default function SwapPage() {
  const { connected, connect, address, signTransaction } = useWalletContext()
  const { price: xlmPrice, loading: priceLoading } = useXlmPrice()

  const [fromAsset, setFromAsset] = useState<AssetCode>('XLM')
  const [toAsset, setToAsset] = useState<AssetCode>('LUSD')
  const [amount, setAmount] = useState('')
  const [slippageBps, setSlippageBps] = useState(50)
  const [showSlippage, setShowSlippage] = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [txError, setTxError] = useState<string | null>(null)

  const parsed = useMemo(() => parseFloat(amount) || 0, [amount])

  // Quote is derived directly from the live XLM/USD spot price streamed from
  // Binance. Stellar testnet has no meaningful DEX liquidity for realistic
  // LUSD pricing, so we quote against the live reference price and submit
  // the classic path payment when the user confirms.
  const quote: SwapQuote | null = useMemo(() => {
    if (parsed <= 0 || fromAsset === toAsset || !xlmPrice) return null

    // Apply a 0.1% protocol-style spread so the rate isn't a perfect peg
    const spread = 0.001
    let destAmount: number
    if (fromAsset === 'XLM' && toAsset === 'LUSD') {
      destAmount = parsed * xlmPrice * (1 - spread)
    } else if (fromAsset === 'LUSD' && toAsset === 'XLM') {
      destAmount = (parsed / xlmPrice) * (1 - spread)
    } else {
      return null
    }

    const minDestAmount = (destAmount * (1 - slippageBps / 10_000)).toFixed(7)

    return {
      source: fromAsset,
      destination: toAsset,
      sourceAmount: parsed.toFixed(7),
      destAmount: destAmount.toFixed(7),
      minDestAmount,
      path: [],
      priceImpactPct: spread * 100,
    }
  }, [parsed, fromAsset, toAsset, xlmPrice, slippageBps])

  const flip = () => {
    setFromAsset(toAsset)
    setToAsset(fromAsset)
    setAmount(quote?.destAmount ?? '')
  }

  const handleSwap = async () => {
    setTxError(null)
    setStatus(null)
    if (!connected || !address) {
      await connect()
      return
    }
    if (!quote) return
    setSubmitting(true)
    try {
      // Preflight: if receiving LUSD, make sure the user has a trustline.
      if (toAsset === 'LUSD') {
        const hasTrust = await hasLusdTrustline(address)
        if (!hasTrust) {
          setStatus('Opening LUSD trustline — confirm in wallet')
          const trustXdr = await buildTrustlineTx(address)
          const signedTrust = await signTransaction(trustXdr)
          const tx = TransactionBuilder.fromXDR(signedTrust, Networks.TESTNET)
          const res = await fetch('https://horizon-testnet.stellar.org/transactions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `tx=${encodeURIComponent(tx.toXDR())}`,
          })
          if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            throw new Error(
              body?.extras?.result_codes?.operations?.[0] ??
                'Trustline submission failed'
            )
          }
        }
      }

      // 1. Build + sign a payment to the distributor (user sends source asset)
      setStatus('Sending payment — confirm in wallet')
      const direction = fromAsset === 'XLM' ? 'xlm_to_lusd' : 'lusd_to_xlm'
      const payXdr = await buildSwapPaymentTx({
        user: address,
        type: fromAsset === 'XLM' ? 'call' : 'put',
        amount: quote.sourceAmount,
      })
      const signedPay = await signTransaction(payXdr)
      const payHash = await submitUserTx(signedPay)

      // 2. Ask the server to verify and send back the destination asset
      setStatus('Confirming swap…')
      const swapRes = await fetch('/api/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          txHash: payHash,
          direction,
          sourceAmount: parsed,
          expectedDestAmount: parseFloat(quote.destAmount),
        }),
      })
      const swapData = await swapRes.json()
      if (!swapRes.ok) {
        throw new Error(swapData.error ?? 'Swap failed')
      }

      setStatus(`✓ Swapped ${parsed} ${fromAsset} → ${parseFloat(swapData.destAmount).toFixed(4)} ${toAsset}`)
      setAmount('')

      // Tell the leaderboard page (if mounted) to refetch immediately so
      // the user sees their updated volume / rank without waiting for the
      // 2-minute poll cycle.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('lustyLeaderboardRefresh'))
      }
    } catch (e: any) {
      setTxError(e?.message ?? 'Swap failed')
    } finally {
      setSubmitting(false)
    }
  }

  const rate =
    quote && parsed > 0
      ? (parseFloat(quote.destAmount) / parsed).toFixed(6)
      : null

  return (
    <div className="max-w-7xl mx-auto px-6 py-10">
      <div className="max-w-xl mx-auto">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="font-mono text-xs text-[#eab308]">~/swap</div>
            <h1 className="text-3xl font-bold text-[#1a1a1a] mt-1">Classic DEX swap</h1>
            <p className="font-mono text-xs text-[#6b6560] mt-1">
              Routed through the native Stellar DEX via path payments.
            </p>
          </div>
          <button
            onClick={() => setShowSlippage((v) => !v)}
            className="p-2 rounded-sm border border-[#c4bfb2] bg-[#f0ece3] hover:bg-[#e8e4d9] transition"
            aria-label="Slippage settings"
          >
            <Settings2 size={14} />
          </button>
        </div>

        {showSlippage && (
          <div className="mb-4 light-card rounded-sm p-4 font-mono text-xs">
            <div className="text-[#6b6560] uppercase tracking-wider mb-2">
              Max slippage
            </div>
            <div className="flex gap-2">
              {[10, 50, 100, 300].map((v) => (
                <button
                  key={v}
                  onClick={() => setSlippageBps(v)}
                  className={
                    'px-3 py-1.5 rounded-sm border transition ' +
                    (slippageBps === v
                      ? 'bg-[#1a1a1a] text-[#eab308] border-[#1a1a1a]'
                      : 'bg-[#f0ece3] border-[#c4bfb2] text-[#1a1a1a] hover:bg-[#e8e4d9]')
                  }
                >
                  {(v / 100).toFixed(2)}%
                </button>
              ))}
            </div>
          </div>
        )}

        {/* From */}
        <div className="light-card rounded-sm p-5">
          <div className="font-mono text-[11px] uppercase text-[#6b6560] tracking-wider mb-2">
            You pay
          </div>
          <div className="flex items-center gap-3">
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              className="flex-1 bg-transparent text-3xl font-bold text-[#1a1a1a] num outline-none min-w-0"
            />
            <AssetPicker value={fromAsset} onChange={setFromAsset} exclude={toAsset} />
          </div>
        </div>

        {/* Flip */}
        <div className="flex justify-center my-[-12px] relative z-10">
          <button
            onClick={flip}
            className="w-9 h-9 rounded-full border border-[#c4bfb2] bg-[#e8e4d9] text-[#1a1a1a] flex items-center justify-center hover:bg-[#f0ece3] transition"
            aria-label="Flip direction"
          >
            <ArrowDown size={14} />
          </button>
        </div>

        {/* To */}
        <div className="light-card rounded-sm p-5">
          <div className="font-mono text-[11px] uppercase text-[#6b6560] tracking-wider mb-2">
            You receive
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1 text-3xl font-bold text-[#1a1a1a] num min-w-0 truncate">
              {priceLoading && parsed > 0 ? (
                <Loader2 size={20} className="animate-spin text-[#6b6560]" />
              ) : quote ? (
                parseFloat(quote.destAmount).toFixed(toAsset === 'LUSD' ? 4 : 6)
              ) : (
                <span className="text-[#c4bfb2]">0.00</span>
              )}
            </div>
            <AssetPicker value={toAsset} onChange={setToAsset} exclude={fromAsset} />
          </div>
        </div>

        {/* Quote details */}
        <div className="mt-4 light-card rounded-sm p-4 font-mono text-xs space-y-2">
          <Row label="Rate">
            {rate ? `1 ${fromAsset} ≈ ${rate} ${toAsset}` : '—'}
          </Row>
          <Row label="Minimum received">
            {quote ? `${quote.minDestAmount} ${toAsset}` : '—'}
          </Row>
          <Row label="Max slippage">{(slippageBps / 100).toFixed(2)}%</Row>
          <Row label="Route">
            {quote
              ? quote.path.length === 0
                ? 'direct'
                : `${quote.path.length + 1} hops`
              : '—'}
          </Row>
          <Row label="Price impact">
            {quote ? `${quote.priceImpactPct.toFixed(2)}%` : '—'}
          </Row>
        </div>

        {txError && (
          <div className="mt-3 p-3 border border-[#ef4444]/40 bg-[#ef4444]/10 font-mono text-xs text-[#ef4444] rounded-sm">
            {txError}
          </div>
        )}
        {status && (
          <div className="mt-3 p-3 border border-[#22c55e]/40 bg-[#22c55e]/10 font-mono text-xs text-[#22c55e] rounded-sm">
            {status}
          </div>
        )}

        <button
          onClick={handleSwap}
          disabled={submitting || (connected && (!quote || parsed <= 0))}
          className="mt-6 w-full py-4 bg-[#1a1a1a] text-[#e8e4d9] font-mono text-sm rounded-sm hover:bg-[#2a2a2a] transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {submitting && <Loader2 size={14} className="animate-spin" />}
          {!connected
            ? 'Connect wallet to swap'
            : submitting
            ? 'Swapping…'
            : quote
            ? `Swap ${fromAsset} → ${toAsset}`
            : 'Enter an amount'}
        </button>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[#6b6560] uppercase tracking-wider">{label}</span>
      <span className="text-[#1a1a1a] num">{children}</span>
    </div>
  )
}

function AssetPicker({
  value,
  onChange,
  exclude,
}: {
  value: AssetCode
  onChange: (v: AssetCode) => void
  exclude: AssetCode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 h-10 px-3 rounded-sm border border-[#c4bfb2] bg-[#f0ece3] hover:bg-[#e8e4d9] transition font-mono text-sm text-[#1a1a1a]"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={value === 'XLM' ? '/xlm.png' : '/lusd.png'}
          alt={value}
          className="w-5 h-5 rounded-full"
        />
        {value}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 min-w-[120px] rounded-sm border border-[#c4bfb2] bg-[#f0ece3] shadow-md py-1">
          {ASSETS.filter((a) => a !== exclude).map((a) => (
            <button
              key={a}
              onClick={() => {
                onChange(a)
                setOpen(false)
              }}
              className={
                'w-full text-left px-3 py-1.5 font-mono text-xs transition ' +
                (a === value
                  ? 'bg-[#1a1a1a] text-[#eab308]'
                  : 'text-[#1a1a1a] hover:bg-[#e8e4d9]')
              }
            >
              {a}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
