'use client'
import { useMemo, useState, useEffect, useRef } from 'react'
import { StrikeCard } from './StrikeCard'
import { TokenInput } from '@/components/shared/TokenInput'
import { PositionSummary } from './PositionSummary'
import { EarnButton } from './EarnButton'
import { useWalletContext } from '@/providers/WalletProvider'
import { MIN_DEPOSIT_XLM, MAX_DEPOSIT_XLM, formatExpiry, formatUsdc } from '@/lib/utils'
import { useXlmPrice } from '@/hooks/useXlmPrice'
import { useVaultStats } from '@/hooks/useVaultStats'
import { getExpiryOptions, ExpiryOption } from '@/lib/expiries'
import { StablePicker, Stable } from '@/components/shared/StablePicker'
import { buildVaultDepositTx, submitUserTx } from '@/lib/vault'
import { savePosition } from '@/lib/positions'
import { buildTrustlineTx, hasLusdTrustline } from '@/lib/swap'
import { TransactionBuilder, Networks } from '@stellar/stellar-sdk'
import { ChevronDown, TrendingUp, TrendingDown } from 'lucide-react'

interface StrikeSelectorProps {
  assetSymbol: string
  type: 'call' | 'put'
}

// One priced strike returned by /api/vault/quote — only the user-facing fields.
interface Rung {
  index: number
  strike: number
  label: string
  apr: number
  userPremium: number
}

export function StrikeSelector({ assetSymbol, type }: StrikeSelectorProps) {
  const { connected, connect, address, signTransaction } = useWalletContext()
  const { price: xlmPrice, change24h } = useXlmPrice()
  const { stats: vaultStats, refresh: refreshVaultStats } = useVaultStats(30_000)
  const pricePositive = change24h >= 0
  const [txLoading, setTxLoading] = useState(false)

  // USD-denominated cap/util for the dynamic APR engine (call: XLM × spot).
  const realStats = useMemo(() => {
    if (!vaultStats) return undefined
    if (type === 'call') {
      if (!xlmPrice) return undefined
      return {
        totalDeposited: vaultStats.call.utilized * xlmPrice,
        vaultCap: vaultStats.call.cap * xlmPrice,
      }
    }
    return {
      totalDeposited: vaultStats.put.utilized,
      vaultCap: vaultStats.put.cap,
    }
  }, [vaultStats, xlmPrice, type])

  // Expiries derived from real on-chain utilization when available so the
  // dynamic APR engine drops the offered APR as the vault fills up.
  const baseExpiries = useMemo(
    () => getExpiryOptions(type, realStats),
    [type, realStats],
  )
  const [expiries, setExpiries] = useState<ExpiryOption[]>(baseExpiries)
  useEffect(() => setExpiries(baseExpiries), [baseExpiries])

  const [selectedExpiryIdx, setSelectedExpiryIdx] = useState(0)
  const [stable, setStable] = useState<Stable>('LUSD')
  const [expiryOpen, setExpiryOpen] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(1)
  const [amountStr, setAmountStr] = useState('')
  const [success, setSuccess] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [successHash, setSuccessHash] = useState<string | null>(null)

  const expiry = expiries[selectedExpiryIdx]

  // Close dropdown on outside click
  const dropdownRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!expiryOpen) return
    const onClick = (e: MouseEvent) => {
      if (!dropdownRef.current?.contains(e.target as Node)) setExpiryOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [expiryOpen])

  // Strikes + APR come from the server quote engine (/api/vault/quote) — the
  // SAME engine that pays the premium on deposit — so what's shown equals what's
  // paid. The engine prices Black-76 off XLM's real realized vol (no fabricated
  // σ) and the perp forward, with a utilization-aware haircut. We pass the
  // selected expiry's days + pool utilization so the quote matches the payout.
  const [strikes, setStrikes] = useState<Rung[]>([])
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)

  useEffect(() => {
    if (!expiry) return
    const ctrl = new AbortController()
    setQuoteLoading(true)
    setQuoteError(null)
    const params = new URLSearchParams({
      side: type,
      days: String(expiry.daysToExpiry),
      util: String(expiry.utilization ?? 0),
    })
    fetch(`/api/vault/quote?${params.toString()}`, { signal: ctrl.signal })
      .then(async (r) => {
        const j = await r.json()
        if (!r.ok || !j.ok) throw new Error(j.error ?? 'quote failed')
        setStrikes(j.strikes as Rung[])
      })
      .catch((e) => {
        if (e?.name === 'AbortError') return
        setQuoteError(e?.message ?? 'quote unavailable')
        setStrikes([])
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setQuoteLoading(false)
      })
    return () => ctrl.abort()
  }, [type, expiry])

  const amount = useMemo(() => parseFloat(amountStr) || 0, [amountStr])
  const selectedStrike = strikes[selectedIdx]

  const apr = selectedStrike?.apr ?? 0

  // Premium = per-unit user premium × number of option units. This is exactly
  // what the deposit route pays (units = XLM for calls, cash/strike for puts),
  // so the displayed upfront equals the paid upfront.
  const premium = useMemo(() => {
    if (!selectedStrike) return 0
    const units =
      type === 'call' ? amount : selectedStrike.strike > 0 ? amount / selectedStrike.strike : 0
    return selectedStrike.userPremium * units
  }, [selectedStrike, amount, type])

  // The capacity bucket for the selected expiry — drives the cap gate + donut.
  const selectedBucket = useMemo(() => {
    if (!vaultStats || !expiry) return undefined
    const key = expiry.date.toISOString().slice(0, 10)
    return vaultStats.buckets.find((b) => b.dateKey === key)
  }, [vaultStats, expiry])

  // Which expiries are full, to flag them in the dropdown.
  const fullByKey = useMemo(() => {
    const m = new Map<string, boolean>()
    for (const b of vaultStats?.buckets ?? []) {
      m.set(b.dateKey, type === 'call' ? b.callFull : b.putFull)
    }
    return m
  }, [vaultStats, type])

  // Block deposits when the selected expiry is full (a full expiry blocks only
  // itself). Mirrors the server's 409 so the user can't sign a doomed deposit.
  const vaultFull = useMemo(() => {
    if (!selectedBucket) return false
    return type === 'call' ? selectedBucket.callFull : selectedBucket.putFull
  }, [type, selectedBucket])

  const epochUtil = useMemo(() => {
    if (!selectedBucket) return 0
    const u = type === 'call' ? selectedBucket.callXlm : selectedBucket.putUsd
    const c =
      type === 'call' ? selectedBucket.callCapXlm : selectedBucket.putCapUsd
    return c > 0 ? Math.min(1, u / c) : 0
  }, [type, selectedBucket])

  const minAmount =
    type === 'call' ? MIN_DEPOSIT_XLM : MIN_DEPOSIT_XLM * (xlmPrice || 0.1)
  const maxAmount =
    type === 'call' ? MAX_DEPOSIT_XLM : MAX_DEPOSIT_XLM * (xlmPrice || 0.1)
  const usdValue =
    type === 'call' ? amount * (xlmPrice || 0) : amount

  const handleEarn = async () => {
    setError(null); setSuccess(null)
    if (!connected) { await connect(); return }
    if (vaultFull) {
      setError(
        `This expiry's ${type === 'call' ? 'covered-call' : 'cash-secured-put'} epoch is full. Pick another expiry.`
      )
      return
    }
    if (amount <= 0) { setError('Enter an amount'); return }
    if (amount < minAmount) {
      setError(`Minimum deposit is ${minAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${type === 'call' ? assetSymbol : stable}`)
      return
    }
    if (amount > maxAmount) {
      setError(`Maximum deposit is ${maxAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${type === 'call' ? assetSymbol : stable}`)
      return
    }
    if (!address) { setError('Wallet not connected'); return }
    setTxLoading(true)
    try {
      // 1. Ensure LUSD trustline so the user can receive the premium.
      const hasTrust = await hasLusdTrustline(address)
      if (!hasTrust) {
        setSuccess('Opening LUSD trustline — confirm in wallet')
        const trustXdr = await buildTrustlineTx(address)
        const signedTrust = await signTransaction(trustXdr)
        const trustTx = TransactionBuilder.fromXDR(signedTrust, Networks.TESTNET)
        const trustRes = await fetch('https://horizon-testnet.stellar.org/transactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `tx=${encodeURIComponent(trustTx.toXDR())}`,
        })
        if (!trustRes.ok) {
          const body = await trustRes.json().catch(() => ({}))
          throw new Error(
            body?.extras?.result_codes?.operations?.[0] ??
              'Trustline submission failed'
          )
        }
      }

      // 2. Build + sign the collateral payment to the vault distributor.
      setSuccess('Sending collateral — confirm in wallet')
      const depositXdr = await buildVaultDepositTx({
        user: address,
        type,
        amount: amount.toFixed(7),
      })
      const signedDeposit = await signTransaction(depositXdr)
      const depositHash = await submitUserTx(signedDeposit)

      // 3. Ask the server to verify the deposit and drip the upfront.
      setSuccess(`Deposit confirmed · claiming upfront…`)
      // Server reprices the premium itself from (spot, strike, days, side)
      // — it ignores any APR the client sends. We omit `apr` from the body
      // so the wire matches what the server actually trusts.
      const res = await fetch('/api/vault/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          txHash: depositHash,
          type,
          collateralAmount: amount,
          strikePrice: selectedStrike!.strike,
          daysToExpiry: expiry.daysToExpiry,
          expiryIso: expiry.date.toISOString(),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error ?? 'Vault deposit API failed')
      }

      setSuccess(`✓ ${data.premium} LUSD upfront received`)
      setSuccessHash(depositHash)
      setAmountStr('')

      // Persist the position so the dashboard can show it.
      savePosition({
        id: depositHash,
        address,
        type,
        asset: type === 'call' ? assetSymbol : stable,
        collateralAmount: amount,
        strikePrice: selectedStrike!.strike,
        strikeIndex: selectedIdx,
        apr,
        premium: parseFloat(data.premium),
        depositHash,
        premiumHash: data.premiumHash ?? '',
        expiryIso: expiry.date.toISOString(),
        expiryLabel: expiry.label,
        daysToExpirySnapshot: expiry.daysToExpiry,
        createdAt: Date.now(),
        settled: false,
      })

      // Optimistic UI: bump utilization on the selected expiry so APR
      // responds immediately even before the next vault-stats poll lands.
      setExpiries((prev) =>
        prev.map((e, i) => {
          if (i !== selectedExpiryIdx) return e
          const depositedUsd = type === 'call' ? amount * xlmPrice : amount
          const newDeposited = e.totalDeposited + depositedUsd
          return {
            ...e,
            totalDeposited: newDeposited,
            utilization: Math.min(0.98, newDeposited / e.vaultCap),
          }
        })
      )

      // Trigger an immediate vault-stats refresh so other widgets (epoch
      // utilization bar) reflect the new on-chain balance without waiting
      // for the 30s poll cycle.
      refreshVaultStats()

      // Tell the leaderboard page (if mounted) to refetch immediately so
      // the user sees their updated rank without waiting up to 2 minutes.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('lustyLeaderboardRefresh'))
      }
    } catch (e: any) {
      setError(e?.message ?? 'Transaction failed')
    } finally {
      setTxLoading(false)
    }
  }

  return (
    <div className="space-y-7">
      {/* Compact tab bar */}
      <div className="light-card rounded-sm flex items-stretch font-mono text-xs relative">
        <div className="flex items-center gap-2 px-4 border-r border-line">
          {assetSymbol === 'XLM' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/xlm.png" alt="XLM" className="w-6 h-6 rounded-full" />
          ) : (
            <div className="w-6 h-6 rounded-full bg-inverse text-[#eab308] font-bold flex items-center justify-center text-[10px]">
              {assetSymbol[0]}
            </div>
          )}
          <span className="text-ink font-semibold">{assetSymbol}</span>
        </div>
        <div className="flex items-center px-4 border-r border-line text-ink">
          {type === 'call' ? 'Covered call' : 'Cash secured put'}
        </div>
        <div className="relative border-r border-line" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setExpiryOpen((v) => !v)}
            className="h-full flex items-center gap-1 px-4 text-ink font-semibold hover:bg-surface transition"
          >
            {expiry?.label ?? '—'}
            <ChevronDown size={12} />
          </button>
          {expiryOpen && (
            <div className="absolute left-0 top-full mt-1 z-20 min-w-[140px] rounded-sm border border-line bg-card shadow-md py-1">
              {expiries.map((e, i) => {
                const eFull = fullByKey.get(e.date.toISOString().slice(0, 10)) ?? false
                return (
                  <button
                    key={e.id}
                    onClick={() => { setSelectedExpiryIdx(i); setExpiryOpen(false) }}
                    className={
                      'w-full text-left px-3 py-1.5 font-mono text-xs transition flex items-center justify-between gap-2 ' +
                      (i === selectedExpiryIdx
                        ? 'bg-inverse text-[#eab308]'
                        : 'text-ink hover:bg-surface')
                    }
                  >
                    <span>{e.label} · {e.daysToExpiry}d</span>
                    {eFull && <span className="text-[#ef4444] font-semibold">FULL</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex-1" />

        <div className="hidden sm:flex items-center gap-1.5 px-4 border-l border-line">
          <span className="num text-ink font-semibold">
            {xlmPrice ? formatUsdc(xlmPrice) : '—'}
          </span>
          <span className={`num text-[10px] flex items-center gap-0.5 ${pricePositive ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
            {pricePositive ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
            {change24h.toFixed(2)}%
          </span>
        </div>
        <div className="hidden md:flex items-center gap-2 px-4 border-l border-line">
          <div className="relative w-8 h-8">
            <svg viewBox="0 0 32 32" className="w-8 h-8 -rotate-90">
              <circle cx="16" cy="16" r="13" fill="none" className="stroke-line" strokeWidth="3" />
              <circle
                cx="16" cy="16" r="13" fill="none"
                stroke={vaultFull ? '#ef4444' : '#eab308'} strokeWidth="3"
                strokeDasharray={`${epochUtil * 81.68} 81.68`}
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div className="text-[10px] leading-tight">
            <div className={`num font-semibold ${vaultFull ? 'text-[#ef4444]' : 'text-ink'}`}>
              {vaultFull ? 'FULL' : `${(epochUtil * 100).toFixed(0)}%`}
            </div>
            <div className="text-ink-2">{vaultFull ? 'this expiry' : 'used'}</div>
          </div>
        </div>
      </div>

      <div className="text-center text-[15px] text-ink">
        Choose the price at which you are happy to{' '}
        <strong>{type === 'call' ? 'sell' : 'buy'} {assetSymbol}</strong> on{' '}
        <strong>{formatExpiry(expiry?.date ?? new Date())}</strong>
        <span className="text-ink-2"> (in {expiry?.daysToExpiry ?? 0} days)</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {strikes.map((s, i) => (
          <StrikeCard
            key={`${expiry?.id}-${i}`}
            index={i}
            strike={s.strike}
            apr={s.apr}
            label={s.label}
            selected={selectedIdx === i}
            onClick={() => setSelectedIdx(i)}
          />
        ))}
      </div>

      <TokenInput
        label={type === 'call' ? 'deposit amount' : 'collateral amount'}
        value={amountStr}
        onChange={setAmountStr}
        symbol={type === 'call' ? assetSymbol : stable}
        min={minAmount}
        max={maxAmount}
        usdValue={usdValue}
        symbolSlot={
          type === 'put' ? <StablePicker value={stable} onChange={setStable} /> : undefined
        }
      />

      {selectedStrike && expiry && (
        <PositionSummary
          premium={premium}
          apr={apr}
          xlmAmount={type === 'call' ? amount : 0}
          usdcAmount={type === 'put' ? amount : 0}
          strikePrice={selectedStrike.strike}
          expiryDate={expiry.date}
          type={type}
        />
      )}

      {quoteLoading && strikes.length === 0 && (
        <div className="p-3 font-mono text-xs text-ink-2 rounded-sm">Pricing strikes…</div>
      )}
      {quoteError && (
        <div className="p-3 border border-[#f59e0b]/40 bg-[#f59e0b]/10 font-mono text-xs text-[#f59e0b] rounded-sm">
          Couldn&apos;t load live pricing: {quoteError}
        </div>
      )}

      {error && (
        <div className="p-3 border border-[#ef4444]/40 bg-[#ef4444]/10 font-mono text-xs text-[#ef4444] rounded-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="p-3 border border-[#22c55e]/40 bg-[#22c55e]/10 font-mono text-xs text-[#22c55e] rounded-sm flex items-center justify-between gap-3 flex-wrap">
          <span>{success}</span>
          {successHash && (
            <a
              href={`https://stellarchain.io/tx/${successHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-ink truncate"
            >
              {successHash.slice(0, 10)}…
            </a>
          )}
        </div>
      )}

      {vaultFull && (
        <div className="p-3 border border-[#ef4444]/40 bg-[#ef4444]/10 font-mono text-xs text-ink rounded-sm">
          This expiry&apos;s {type === 'call' ? 'covered-call' : 'cash-secured-put'} epoch is
          full — pick a different expiry above with open capacity. Depositing here
          would be rejected, so the button is disabled.
        </div>
      )}

      <EarnButton
        onClick={handleEarn}
        loading={txLoading}
        disabled={vaultFull || amount <= 0 || amount < minAmount || amount > maxAmount}
        label={
          vaultFull
            ? 'Vault full'
            : connected
              ? 'Earn upfront now'
              : 'Connect wallet to earn'
        }
      />
    </div>
  )
}
