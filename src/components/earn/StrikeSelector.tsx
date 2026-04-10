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
import { generateCallStrikes, generatePutStrikes, StrikeOption } from '@/lib/pricing'
import { getExpiryOptions, adjustApr, ExpiryOption } from '@/lib/expiries'
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

export function StrikeSelector({ assetSymbol, type }: StrikeSelectorProps) {
  const { connected, connect, address, signTransaction } = useWalletContext()
  const { price: xlmPrice, change24h } = useXlmPrice()
  const { stats: vaultStats, refresh: refreshVaultStats } = useVaultStats(30_000)
  const pricePositive = change24h >= 0
  const [txLoading, setTxLoading] = useState(false)

  // Convert /api/vault/stats numbers (XLM) into a USD-denominated cap/util
  // pair so the same expiries.ts code works for call and put vaults.
  const realStats = useMemo(() => {
    if (!vaultStats || !xlmPrice) return undefined
    return {
      totalDeposited: vaultStats.utilizedXlm * xlmPrice,
      vaultCap: vaultStats.capXlm * xlmPrice,
    }
  }, [vaultStats, xlmPrice])

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

  // Strikes computed locally so APR reflects both the selected expiry's
  // days-to-expiry AND its pool utilization (dynamic APR layer).
  const strikes: StrikeOption[] = useMemo(() => {
    if (!xlmPrice || !expiry) return []
    const gen = type === 'call' ? generateCallStrikes : generatePutStrikes
    const base = gen(xlmPrice, 0.80, expiry.daysToExpiry)
    return base.map((s) => ({ ...s, apr: adjustApr(s.apr, expiry) }))
  }, [xlmPrice, expiry, type])

  const amount = useMemo(() => parseFloat(amountStr) || 0, [amountStr])
  const selectedStrike = strikes[selectedIdx]

  const apr = selectedStrike?.apr ?? 0

  // Premium is derived directly from the *displayed* APR and the notional
  // so the UI stays internally consistent (Rysk-style):
  //   premium_usdc = notional_usdc × (APR / 100) × (days / 365)
  const premium = useMemo(() => {
    if (!selectedStrike || !expiry) return 0
    const notionalUsd = type === 'call' ? amount * (xlmPrice || 0) : amount
    return notionalUsd * (apr / 100) * (expiry.daysToExpiry / 365)
  }, [selectedStrike, expiry, amount, xlmPrice, apr, type])

  const minAmount =
    type === 'call' ? MIN_DEPOSIT_XLM : MIN_DEPOSIT_XLM * (xlmPrice || 0.1)
  const maxAmount =
    type === 'call' ? MAX_DEPOSIT_XLM : MAX_DEPOSIT_XLM * (xlmPrice || 0.1)
  const usdValue =
    type === 'call' ? amount * (xlmPrice || 0) : amount

  const handleEarn = async () => {
    setError(null); setSuccess(null)
    if (!connected) { await connect(); return }
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
      const res = await fetch('/api/vault/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          txHash: depositHash,
          type,
          collateralAmount: amount,
          strikePrice: selectedStrike!.strike,
          apr,
          daysToExpiry: expiry.daysToExpiry,
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
        <div className="flex items-center gap-2 px-4 border-r border-[#c4bfb2]">
          {assetSymbol === 'XLM' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/xlm.png" alt="XLM" className="w-6 h-6 rounded-full" />
          ) : (
            <div className="w-6 h-6 rounded-full bg-[#1a1a1a] text-[#eab308] font-bold flex items-center justify-center text-[10px]">
              {assetSymbol[0]}
            </div>
          )}
          <span className="text-[#1a1a1a] font-semibold">{assetSymbol}</span>
        </div>
        <div className="flex items-center px-4 border-r border-[#c4bfb2] text-[#1a1a1a]">
          {type === 'call' ? 'Covered call' : 'Cash secured put'}
        </div>
        <div className="relative border-r border-[#c4bfb2]" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setExpiryOpen((v) => !v)}
            className="h-full flex items-center gap-1 px-4 text-[#1a1a1a] font-semibold hover:bg-[#e8e4d9] transition"
          >
            {expiry?.label ?? '—'}
            <ChevronDown size={12} />
          </button>
          {expiryOpen && (
            <div className="absolute left-0 top-full mt-1 z-20 min-w-[140px] rounded-sm border border-[#c4bfb2] bg-[#f0ece3] shadow-md py-1">
              {expiries.map((e, i) => (
                <button
                  key={e.id}
                  onClick={() => { setSelectedExpiryIdx(i); setExpiryOpen(false) }}
                  className={
                    'w-full text-left px-3 py-1.5 font-mono text-xs transition ' +
                    (i === selectedExpiryIdx
                      ? 'bg-[#1a1a1a] text-[#eab308]'
                      : 'text-[#1a1a1a] hover:bg-[#e8e4d9]')
                  }
                >
                  {e.label} · {e.daysToExpiry}d
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1" />

        <div className="hidden sm:flex items-center gap-1.5 px-4 border-l border-[#c4bfb2]">
          <span className="num text-[#1a1a1a] font-semibold">
            {xlmPrice ? formatUsdc(xlmPrice) : '—'}
          </span>
          <span className={`num text-[10px] flex items-center gap-0.5 ${pricePositive ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
            {pricePositive ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
            {change24h.toFixed(2)}%
          </span>
        </div>
        <div className="hidden md:flex items-center gap-2 px-4 border-l border-[#c4bfb2]">
          <div className="relative w-8 h-8">
            <svg viewBox="0 0 32 32" className="w-8 h-8 -rotate-90">
              <circle cx="16" cy="16" r="13" fill="none" stroke="#c4bfb2" strokeWidth="3" />
              <circle
                cx="16" cy="16" r="13" fill="none" stroke="#eab308" strokeWidth="3"
                strokeDasharray={`${(expiry?.utilization ?? 0) * 81.68} 81.68`}
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div className="text-[10px] leading-tight">
            <div className="num text-[#1a1a1a] font-semibold">
              {((expiry?.utilization ?? 0) * 100).toFixed(0)}%
            </div>
            <div className="text-[#6b6560]">used</div>
          </div>
        </div>
      </div>

      <div className="text-center text-[15px] text-[#1a1a1a]">
        Choose the price at which you are happy to{' '}
        <strong>{type === 'call' ? 'sell' : 'buy'} {assetSymbol}</strong> on{' '}
        <strong>{formatExpiry(expiry?.date ?? new Date())}</strong>
        <span className="text-[#6b6560]"> (in {expiry?.daysToExpiry ?? 0} days)</span>
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
              className="underline hover:text-[#1a1a1a] truncate"
            >
              {successHash.slice(0, 10)}…
            </a>
          )}
        </div>
      )}

      <EarnButton
        onClick={handleEarn}
        loading={txLoading}
        disabled={amount <= 0 || amount < minAmount || amount > maxAmount}
        label={connected ? 'Earn upfront now' : 'Connect wallet to earn'}
      />
    </div>
  )
}
