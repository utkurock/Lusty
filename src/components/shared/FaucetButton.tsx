'use client'
import { useEffect, useRef, useState } from 'react'
import { Loader2, Droplet, ChevronDown } from 'lucide-react'
import { TransactionBuilder, Networks } from '@stellar/stellar-sdk'
import { useWalletContext } from '@/providers/WalletProvider'
import { buildTrustlineTx, hasTrustline } from '@/lib/swap'
import { LUSD_CODE, LUSD_ISSUER } from '@/lib/lusd'
import { BTC } from '@/lib/assets'
import type { StellarAsset } from '@/lib/assets'

// What the faucet offers, and what a claim needs before it can land.
//
// The amounts are not a matter of taste. LUSD is minted a million at a time
// and LBTC a thousand, once — so the BTC drip is a hundredth of a unit, ten
// times the smallest position its book will write, which is enough to open one
// and watch it settle and not much more. The server holds the real limits: one
// claim a day per asset, a lifetime bound per address and a daily bound across
// everyone. This list only decides what is on the menu.
interface FaucetAsset {
  /** URL segment and log name. */
  symbol: string
  label: string
  /** What one claim pays, for the menu. */
  shown: string
  /** The trustline a claim needs first, if any. */
  trustline?: StellarAsset
}

const ASSETS: FaucetAsset[] = [
  { symbol: 'XLM', label: 'Get test XLM', shown: '10,000' },
  {
    symbol: 'LUSD',
    label: 'Get test LUSD',
    shown: '1,000',
    trustline: { kind: 'issued', code: LUSD_CODE, issuer: LUSD_ISSUER },
  },
  {
    symbol: 'LBTC',
    label: 'Get test LBTC',
    shown: '0.01',
    trustline: BTC.stellarAsset,
  },
]

export function FaucetButton() {
  const { connected, connect, address, signTransaction } = useWalletContext()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const showToast = (kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text })
    setTimeout(() => setToast(null), 6000)
  }

  const ensureConnected = async () => {
    if (!connected || !address) {
      try {
        await connect()
      } catch {
        /* ignore */
      }
      return false
    }
    return true
  }

  const claim = async (asset: FaucetAsset) => {
    setOpen(false)
    if (!(await ensureConnected()) || !address) return
    setBusy(asset.symbol)
    try {
      // 1. The trustline, if this asset needs one. The drip is refused without
      //    it, and a refusal after the wallet prompt is a worse way to learn.
      if (asset.trustline && !(await hasTrustline(address, asset.trustline))) {
        const code = asset.trustline.kind === 'issued' ? asset.trustline.code : asset.symbol
        showToast('ok', `Opening ${code} trustline — confirm in wallet`)
        const xdr = await buildTrustlineTx(address, asset.trustline)
        const signed = await signTransaction(xdr)
        const tx = TransactionBuilder.fromXDR(signed, Networks.TESTNET)
        const res = await fetch('https://horizon-testnet.stellar.org/transactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `tx=${encodeURIComponent(tx.toXDR())}`,
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(
            body?.extras?.result_codes?.operations?.[0] ?? 'Trustline submission failed',
          )
        }
      }

      // 2. The drip itself.
      const drip = await fetch(`/api/faucet/${asset.symbol.toLowerCase()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      })
      const data = await drip.json().catch(() => ({}))
      if (!drip.ok) throw new Error(data.error ?? `${asset.symbol} faucet failed`)
      showToast('ok', `✓ ${data.amount} test ${data.asset} sent`)
    } catch (e: any) {
      showToast('err', e?.message ?? `${asset.symbol} faucet failed`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy !== null}
        className="press h-10 px-3 rounded-sm border border-line bg-card hover:bg-raised text-ink font-mono text-body flex items-center gap-2 disabled:opacity-50 transition"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Droplet size={14} />}
        faucet
        <ChevronDown size={12} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 min-w-[220px] raised-card py-1">
          {ASSETS.map((asset) => (
            <button
              key={asset.symbol}
              onClick={() => claim(asset)}
              className="press w-full text-left px-3 py-2 font-mono text-caption text-ink hover:bg-raised flex items-center justify-between"
            >
              <span>{asset.label}</span>
              <span className="text-ink-2">{asset.shown}</span>
            </button>
          ))}
          {/* Said once, under the list, rather than discovered on the second
              click: the limit is a day per asset, not a queue. */}
          <div className="px-3 pt-2 pb-1 font-mono text-tiny text-ink-faint border-t border-line-light mt-1">
            one claim per asset per day
          </div>
        </div>
      )}

      {toast && (
        <div
          className={
            'absolute right-0 top-full mt-2 z-30 whitespace-nowrap px-3 py-2 rounded-sm border font-mono text-tiny shadow-md ' +
            (toast.kind === 'ok'
              ? 'border-accent-green/40 bg-accent-green/10 text-accent-green'
              : 'border-accent-red/40 bg-accent-red/10 text-accent-red')
          }
        >
          {toast.text}
        </div>
      )}
    </div>
  )
}
