'use client'
import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { StrikeCard } from './StrikeCard'
import { TokenInput } from '@/components/shared/TokenInput'
import { PositionSummary } from './PositionSummary'
import { EarnButton } from './EarnButton'
import { useWalletContext } from '@/providers/WalletProvider'
import {
  MIN_DEPOSIT_XLM,
  MAX_DEPOSIT_XLM,
  MAX_USER_EPOCH_CALL_XLM,
  MAX_USER_EPOCH_PUT_USD,
  formatExpiry,
  formatUsdc,
} from '@/lib/utils'
import { useXlmPrice } from '@/hooks/useXlmPrice'
import { useVaultStats } from '@/hooks/useVaultStats'
import { getExpiryOptions, ExpiryOption } from '@/lib/expiries'
import { StablePicker, Stable } from '@/components/shared/StablePicker'
import { savePosition } from '@/lib/positions'
import { buildTrustlineTx, hasLusdTrustline } from '@/lib/swap'
import { openPosition, coveredUnits } from '@/lib/vault-contract'
import { activeQuoter, cosignWithQuoter } from '@/lib/quoter'
import { fetchLadder, fetchStrikeQuote, type QuotedRung } from '@/lib/quote-client'
import { TransactionBuilder, Networks } from '@stellar/stellar-sdk'
import { ChevronDown, TrendingUp, TrendingDown } from 'lucide-react'

// Wallet-facing labels for each leg of the open. The user is signing one
// transaction; these say what the app is doing while it prepares it.
const PROGRESS = {
  simulating: 'Preparing the position…',
  quoting: 'Getting the protocol signature…',
  signing: 'Opening position — confirm in wallet',
  submitting: 'Submitting to the network…',
} as const

// How far the fresh quote may sit BELOW the one on screen before the deposit
// stops and shows the new number instead.
//
// The ladder is repriced just before the transaction is built, so the premium
// encoded is always the live one — never a stale figure the co-signature would
// refuse. But "live" is not the same as "what the user agreed to": a quote that
// has fallen since it was rendered would otherwise be paid silently, which is
// the exact failure the old one-sided server check allowed. Past this much
// drift the press is treated as consent to a price that no longer exists.
const MAX_QUOTE_DRIFT = 0.01 // 1% of the displayed premium

// How often the displayed ladder is repriced.
const QUOTE_REFRESH_MS = 30_000

interface StrikeSelectorProps {
  assetSymbol: string
  type: 'call' | 'put'
}

// One priced strike returned by /api/vault/quote. Defined by the client that
// calls it (lib/quote-client.ts), not restated here.
type Rung = QuotedRung

export function StrikeSelector({ assetSymbol, type }: StrikeSelectorProps) {
  const { connected, connect, address, signTransaction, syncAddress } =
    useWalletContext()
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

  // The connected wallet's own deposits, so we can pre-check the per-expiry
  // allowance BEFORE any on-chain collateral is sent (mirrors the server's
  // per-user 409). Without this, a wallet that has already filled its
  // 10k-per-expiry allowance could still sign a deposit whose collateral lands
  // in the vault but earns no upfront — money in, nothing back.
  const [walletDeposits, setWalletDeposits] = useState<
    { type: 'call' | 'put'; collateralAmount: number; expiryIso: string | null }[]
  >([])
  // 'idle' before a wallet connects; 'loaded' only after a successful read.
  // Any other state (loading / error) means we do NOT know the wallet's usage,
  // so deposits are blocked fail-closed — at scale we must never let collateral
  // in without first proving the per-expiry allowance has room.
  const [depositsStatus, setDepositsStatus] =
    useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')

  const loadWalletDeposits = useCallback(() => {
    if (!address) { setWalletDeposits([]); setDepositsStatus('idle'); return }
    setDepositsStatus('loading')
    fetch(`/api/vault/positions?address=${address}`)
      .then(async (r) => {
        const d = await r.json().catch(() => null)
        if (!r.ok || !d?.ok || !Array.isArray(d.positions)) {
          throw new Error(d?.error ?? 'positions unavailable')
        }
        setWalletDeposits(d.positions)
        setDepositsStatus('loaded')
      })
      .catch(() => {
        // Fail-closed: we couldn't read this wallet's usage, so we can't prove
        // it has allowance left. Clear any stale rows and mark the check failed
        // — the button stays out of the "Earn" state until a read succeeds.
        setWalletDeposits([])
        setDepositsStatus('error')
      })
  }, [address])

  useEffect(() => { loadWalletDeposits() }, [loadWalletDeposits])

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
  // σ) and the perp forward, with a utilization-aware haircut.
  //
  // We send the EXPIRY and nothing else about it: the server derives both the
  // tenor and the pool utilization from it, through the same function the
  // co-signature calls. Passing our own utilization is what used to break the
  // equality — before the stats poll landed, `expiry.utilization` was a
  // fabricated 0.68, so the ladder was priced against a pool that did not exist.
  const [strikes, setStrikes] = useState<Rung[]>([])
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)

  const expiryIso = useMemo(() => expiry?.date.toISOString() ?? null, [expiry])

  const loadLadder = useCallback(
    (signal?: AbortSignal) => {
      if (!expiryIso) return Promise.resolve()
      setQuoteLoading(true)
      setQuoteError(null)
      return fetchLadder(type, expiryIso, signal)
        .then((ladder) => {
          setStrikes(ladder.strikes)
        })
        .catch((e) => {
          if (e?.name === 'AbortError') return
          setQuoteError(e?.message ?? 'quote unavailable')
          setStrikes([])
        })
        .finally(() => {
          if (!signal?.aborted) setQuoteLoading(false)
        })
    },
    [type, expiryIso],
  )

  // Keep the ladder live on a timer of its own. It used to refresh as a side
  // effect of the vault-stats poll handing back a new object every 30s, which
  // worked by accident and stopped working the moment the quote key became the
  // expiry itself. A displayed premium that stops tracking spot is one the user
  // is more likely to press on and have refused as drifted.
  useEffect(() => {
    const ctrl = new AbortController()
    loadLadder(ctrl.signal)
    const id = setInterval(() => loadLadder(ctrl.signal), QUOTE_REFRESH_MS)
    return () => {
      clearInterval(id)
      ctrl.abort()
    }
  }, [loadLadder])

  const amount = useMemo(() => parseFloat(amountStr) || 0, [amountStr])
  const selectedStrike = strikes[selectedIdx]

  const apr = selectedStrike?.apr ?? 0

  // Premium = per-unit user premium × number of option units, where the unit
  // count is the contract's own `coveredUnits` (XLM for calls, cash/strike for
  // puts) rather than a second copy of that arithmetic — the server multiplies
  // the same way when it verifies the premium it co-signs.
  const premium = useMemo(() => {
    if (!selectedStrike || amount <= 0 || selectedStrike.strike <= 0) return 0
    return selectedStrike.userPremium * coveredUnits(type, amount, selectedStrike.strike)
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

  // How much this wallet has already committed to the selected expiry + side,
  // in collateral units (XLM for calls, USD≈stable for puts). Mirrors the
  // server's per-user per-expiry SUM in reserveDepositCapacity.
  const usedThisExpiry = useMemo(() => {
    if (!expiry) return 0
    const key = expiry.date.toISOString().slice(0, 10)
    return walletDeposits
      .filter((p) => p.type === type && (p.expiryIso ?? '').slice(0, 10) === key)
      .reduce((s, p) => s + (Number(p.collateralAmount) || 0), 0)
  }, [walletDeposits, expiry, type])

  const walletAllowance =
    type === 'call' ? MAX_USER_EPOCH_CALL_XLM : MAX_USER_EPOCH_PUT_USD
  const remainingAllowance = Math.max(0, walletAllowance - usedThisExpiry)
  const allowanceUnit = type === 'call' ? assetSymbol : 'USD'
  // Epsilon so a floating-point collateral sum doesn't false-trip exactly at
  // the cap. Only meaningful once connected (we can't read allowance otherwise).
  const allowanceExceeded = connected && amount > remainingAllowance + 1e-6
  // Fail-closed gate: a connected wallet whose usage hasn't been read yet has
  // an UNKNOWN allowance, so it must not be able to deposit.
  const allowanceVerified = depositsStatus === 'loaded'
  const checkingAllowance = connected && depositsStatus === 'loading'
  const allowanceUnknown = connected && !allowanceVerified && !checkingAllowance

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
    // Fail-closed: never send collateral while the wallet's per-expiry usage is
    // unknown (positions read still pending or failed). Retry the read so a
    // second press can succeed once it recovers.
    if (checkingAllowance) {
      setError('Checking your per-expiry allowance — try again in a moment.')
      return
    }
    if (!allowanceVerified) {
      setError("Couldn't verify your per-expiry allowance — deposits are paused until we can read it. Press again to retry.")
      loadWalletDeposits()
      return
    }
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
    // Per-wallet per-expiry allowance — checked BEFORE sending collateral so we
    // never let the user lock funds in a deposit the server will 409.
    if (allowanceExceeded) {
      setError(
        `You've used ${usedThisExpiry.toLocaleString(undefined, { maximumFractionDigits: 0 })} of ${walletAllowance.toLocaleString()} ${allowanceUnit} for this expiry — ${remainingAllowance.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${allowanceUnit} left. Lower the amount or pick another expiry.`
      )
      return
    }
    if (!address) { setError('Wallet not connected'); return }
    if (!selectedStrike || !expiryIso) { setError('Pick a strike first'); return }
    setTxLoading(true)
    try {
      // 0. Confirm which account the wallet is actually on.
      //
      //    Everything below — the collateral, the premium, the allowance we just
      //    checked — is keyed to one address. Ours came from localStorage, and
      //    the user may have switched accounts in their extension since. The
      //    deposit would still SUCCEED in that case: the address is handed to
      //    the wallet explicitly, so it signs for the account we named, escrows
      //    that account's XLM and pays that account's premium — while the user
      //    watches a different one and reports that nothing arrived.
      const live = await syncAddress()
      if (live && live !== address) {
        setSuccess(null)
        setError(
          `Your wallet is on a different account now (${live.slice(0, 4)}…${live.slice(-4)}). ` +
            `Nothing was sent. The page has switched to it — check the amount and press again.`
        )
        return
      }

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

      // 2. Reprice the strike NOW, and encode that number.
      //
      //    The ladder on screen was priced when the expiry was selected; the
      //    co-signature will price this position when it is asked to sign,
      //    seconds from here. Sending the older of the two numbers is what
      //    produced "premium exceeds the quote" on every downward tick — and,
      //    when the tick went the other way, quietly paid the smaller one.
      setSuccess('Refreshing the quote…')
      const fresh = await fetchStrikeQuote(type, expiryIso, selectedStrike.strike)
      const paidPremium =
        fresh.userPremium * coveredUnits(type, amount, selectedStrike.strike)

      //    Live is not the same as agreed. If the quote has fallen materially
      //    since it was rendered, stop and show the new one rather than paying
      //    a price the user never saw.
      if (paidPremium < premium * (1 - MAX_QUOTE_DRIFT)) {
        loadLadder()
        setSuccess(null)
        setError(
          `The quote moved while you were deciding: ${formatUsdc(premium)} → ` +
            `${formatUsdc(paidPremium)} upfront. Nothing was sent — the strikes ` +
            `above have been repriced, press again to take the new quote.`
        )
        return
      }

      // 3. Open the position on the vault contract. Escrow, premium and the
      //    position record all land in the one transaction the user signs —
      //    no server-held account touches the collateral at any point. The
      //    quoter co-signs only the premium, after repricing it itself.
      //    The transaction has to name the quoter it expects to co-sign, so
      //    ask which key that is before building it.
      const opened = await openPosition({
        owner: address,
        side: type,
        collateral: amount,
        strike: selectedStrike.strike,
        expiry: expiry.date,
        premium: paidPremium,
        quoter: await activeQuoter(),
        signTransaction,
        cosignQuote: (authEntries) =>
          cosignWithQuoter({
            address,
            side: type,
            collateralAmount: amount,
            strikePrice: selectedStrike.strike,
            expiryIso,
            premium: paidPremium,
            authEntries,
          }),
        onProgress: (step) => setSuccess(PROGRESS[step]),
      })

      // 4. Record the position the contract just wrote, for the leaderboard
      //    and analytics. Best-effort: the position exists on chain either way.
      const depositHash = opened.txHash
      await fetch('/api/vault/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          txHash: depositHash,
          positionId: opened.id,
          type,
          collateralAmount: amount,
          strikePrice: selectedStrike.strike,
          daysToExpiry: fresh.daysToExpiry,
          expiryIso,
        }),
      }).catch((recordErr) => {
        console.warn('vault deposit recorded on chain but not indexed', recordErr)
      })

      setSuccess(`✓ ${formatUsdc(paidPremium)} upfront received · position #${opened.id}`)
      setSuccessHash(depositHash)
      setAmountStr('')

      // Cache the position locally for an instant dashboard render. Contract
      // state is the source of truth; this is only what we already know.
      savePosition({
        id: depositHash,
        address,
        type,
        asset: type === 'call' ? assetSymbol : stable,
        collateralAmount: amount,
        strikePrice: selectedStrike.strike,
        strikeIndex: selectedIdx,
        // The quote that was paid, not the one that was on screen.
        apr: fresh.apr,
        premium: paidPremium,
        depositHash,
        // Escrow and premium now settle in the same transaction, so there is
        // no separate payout hash to record.
        premiumHash: depositHash,
        positionId: opened.id,
        expiryIso,
        expiryLabel: expiry.label,
        daysToExpirySnapshot: fresh.daysToExpiry,
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

      // Refresh this wallet's deposits so the per-expiry allowance gate
      // reflects the collateral just committed.
      loadWalletDeposits()

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
      <div className="light-card flex items-stretch font-mono text-caption relative overflow-hidden">
        <div className="flex items-center gap-2 px-4 border-r border-line-light">
          {assetSymbol === 'XLM' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/xlm.png" alt="XLM" className="w-6 h-6 rounded-full" />
          ) : (
            <div className="w-6 h-6 rounded-full bg-inverse text-brand font-bold flex items-center justify-center text-micro">
              {assetSymbol[0]}
            </div>
          )}
          <span className="text-ink font-semibold">{assetSymbol}</span>
        </div>
        <div className="flex items-center px-4 border-r border-line text-ink">
          {type === 'call' ? 'Covered call' : 'Cash secured put'}
        </div>
        <div className="relative border-r border-line-light" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setExpiryOpen((v) => !v)}
            className="press h-full flex items-center gap-1 px-4 text-ink font-semibold hover:bg-raised transition"
          >
            {expiry?.label ?? '—'}
            <ChevronDown size={12} />
          </button>
          {expiryOpen && (
            <div className="raised-card absolute left-0 top-full mt-1 z-20 min-w-[150px] py-1">
              {expiries.map((e, i) => {
                const eFull = fullByKey.get(e.date.toISOString().slice(0, 10)) ?? false
                return (
                  <button
                    key={e.id}
                    onClick={() => { setSelectedExpiryIdx(i); setExpiryOpen(false) }}
                    className={
                      'press w-full text-left px-3 py-1.5 font-mono text-caption transition flex items-center justify-between gap-2 ' +
                      (i === selectedExpiryIdx
                        ? 'bg-inverse text-brand'
                        : 'text-ink hover:bg-raised')
                    }
                  >
                    <span>{e.label} · {e.daysToExpiry}d</span>
                    {eFull && <span className="text-accent-red font-semibold">FULL</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex-1" />

        <div className="hidden sm:flex items-center gap-1.5 px-4 border-l border-line-light">
          <span className="num text-ink font-semibold">
            {xlmPrice ? formatUsdc(xlmPrice) : '—'}
          </span>
          <span className={`num text-micro flex items-center gap-0.5 ${pricePositive ? 'text-accent-green' : 'text-accent-red'}`}>
            {pricePositive ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
            {change24h.toFixed(2)}%
          </span>
        </div>
        <div className="hidden md:flex items-center gap-2 px-4 border-l border-line-light">
          <div className="relative w-8 h-8">
            <svg viewBox="0 0 32 32" className="w-8 h-8 -rotate-90">
              <circle cx="16" cy="16" r="13" fill="none" className="stroke-line" strokeWidth="3" />
              <circle
                cx="16" cy="16" r="13" fill="none"
                stroke={vaultFull ? 'var(--accent-red)' : 'var(--brand)'} strokeWidth="3"
                strokeDasharray={`${epochUtil * 81.68} 81.68`}
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div className="text-micro leading-tight">
            <div className={`num font-semibold ${vaultFull ? 'text-accent-red' : 'text-ink'}`}>
              {vaultFull ? 'FULL' : `${(epochUtil * 100).toFixed(0)}%`}
            </div>
            <div className="text-ink-2">{vaultFull ? 'this expiry' : 'used'}</div>
          </div>
        </div>
      </div>

      <div className="text-center text-lead text-ink">
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
        <div className="notice notice-quiet">Pricing strikes…</div>
      )}
      {quoteError && (
        <div className="notice notice-warn">
          Couldn&apos;t load live pricing: {quoteError}
        </div>
      )}

      {error && (
        <div className="notice notice-error">
          {error}
        </div>
      )}
      {success && (
        <div className="notice notice-ok flex items-center justify-between gap-3 flex-wrap">
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
        <div className="notice notice-error text-ink">
          This expiry&apos;s {type === 'call' ? 'covered-call' : 'cash-secured-put'} epoch is
          full — pick a different expiry above with open capacity. Depositing here
          would be rejected, so the button is disabled.
        </div>
      )}

      {/* Per-wallet allowance warning — shown BEFORE any collateral is sent so
          the user never locks funds in a deposit the server would reject. */}
      {!vaultFull && connected && usedThisExpiry > 0 && (
        <div
          className={
            'notice ' +
            (remainingAllowance <= 0
              ? 'notice-error text-ink'
              : allowanceExceeded
                ? 'notice-warn'
                : 'notice-quiet')
          }
        >
          {remainingAllowance <= 0 ? (
            <>
              You&apos;ve used your full{' '}
              {walletAllowance.toLocaleString()} {allowanceUnit} allowance for this
              expiry. Depositing more here would be rejected server-side (collateral
              locked, no upfront) — pick another expiry, each has a fresh allowance.
            </>
          ) : (
            <>
              Wallet allowance for this expiry:{' '}
              {usedThisExpiry.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              {' / '}
              {walletAllowance.toLocaleString()} {allowanceUnit} used ·{' '}
              <span className="text-ink font-semibold">
                {remainingAllowance.toLocaleString(undefined, { maximumFractionDigits: 0 })} {allowanceUnit} left
              </span>
              {allowanceExceeded && ' — lower the amount to stay within it.'}
            </>
          )}
        </div>
      )}

      {/* Fail-closed notice: allowance couldn't be read, so deposits are paused
          rather than risk letting collateral in against an unknown allowance. */}
      {allowanceUnknown && (
        <div className="notice notice-warn">
          Couldn&apos;t verify your per-expiry allowance right now, so deposits are
          paused — we never let collateral in without confirming you have room.
          Press the button to retry.
        </div>
      )}

      <EarnButton
        onClick={handleEarn}
        loading={txLoading}
        disabled={vaultFull || allowanceExceeded || checkingAllowance || amount <= 0 || amount < minAmount || amount > maxAmount}
        label={
          vaultFull
            ? 'Vault full'
            : checkingAllowance
              ? 'Checking allowance…'
              : allowanceUnknown
                ? 'Retry allowance check'
                : allowanceExceeded
                  ? 'Expiry allowance used'
                  : connected
                    ? 'Earn upfront now'
                    : 'Connect wallet to earn'
        }
      />
    </div>
  )
}
