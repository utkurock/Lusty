'use client'
import { useEffect, useRef, useState } from 'react'
import { Loader2, Droplet, ChevronDown } from 'lucide-react'
import { TransactionBuilder, Networks } from '@stellar/stellar-sdk'
import { useWalletContext } from '@/providers/WalletProvider'
import { buildTrustlineTx, hasLusdTrustline } from '@/lib/swap'

export function FaucetButton() {
  const { connected, connect, address, signTransaction } = useWalletContext()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<'xlm' | 'lusd' | null>(null)
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

  const handleXlm = async () => {
    setOpen(false)
    if (!(await ensureConnected()) || !address) return
    setBusy('xlm')
    try {
      const res = await fetch(
        `https://friendbot.stellar.org/?addr=${encodeURIComponent(address)}`
      )
      const body = await res.text().catch(() => '')
      if (!res.ok) {
        if (body.includes('op_already_exists') || res.status === 400) {
          throw new Error('Account already funded on testnet')
        }
        throw new Error(`Friendbot ${res.status}`)
      }
      showToast('ok', '✓ 10,000 test XLM sent')
    } catch (e: any) {
      showToast('err', e?.message ?? 'XLM faucet failed')
    } finally {
      setBusy(null)
    }
  }

  const handleLusd = async () => {
    setOpen(false)
    if (!(await ensureConnected()) || !address) return
    setBusy('lusd')
    try {
      // 1. Trustline check / open
      const has = await hasLusdTrustline(address)
      if (!has) {
        showToast('ok', 'Opening LUSD trustline — confirm in wallet')
        const xdr = await buildTrustlineTx(address)
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
            body?.extras?.result_codes?.operations?.[0] ??
              'Trustline submission failed'
          )
        }
      }

      // 2. Drip from server-side distributor
      const drip = await fetch('/api/faucet/lusd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      })
      const data = await drip.json()
      if (!drip.ok) {
        throw new Error(data.error ?? 'LUSD faucet failed')
      }
      showToast('ok', `✓ ${data.amount} test LUSD sent`)
    } catch (e: any) {
      showToast('err', e?.message ?? 'LUSD faucet failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy !== null}
        className="h-10 px-3 rounded-sm border border-[#c4bfb2] bg-[#f0ece3] hover:bg-[#e8e4d9] text-[#1a1a1a] font-mono text-sm flex items-center gap-2 disabled:opacity-50 transition"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Droplet size={14} />}
        faucet
        <ChevronDown size={12} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 min-w-[200px] rounded-sm border border-[#c4bfb2] bg-[#f0ece3] shadow-md py-1">
          <button
            onClick={handleXlm}
            className="w-full text-left px-3 py-2 font-mono text-xs text-[#1a1a1a] hover:bg-[#e8e4d9] flex items-center justify-between"
          >
            <span>Get test XLM</span>
            <span className="text-[#6b6560]">10,000</span>
          </button>
          <button
            onClick={handleLusd}
            className="w-full text-left px-3 py-2 font-mono text-xs text-[#1a1a1a] hover:bg-[#e8e4d9] flex items-center justify-between"
          >
            <span>Get test LUSD</span>
            <span className="text-[#6b6560]">1,000</span>
          </button>
        </div>
      )}

      {toast && (
        <div
          className={
            'absolute right-0 top-full mt-2 z-30 whitespace-nowrap px-3 py-2 rounded-sm border font-mono text-[11px] shadow-md ' +
            (toast.kind === 'ok'
              ? 'border-[#22c55e]/40 bg-[#22c55e]/10 text-[#22c55e]'
              : 'border-[#ef4444]/40 bg-[#ef4444]/10 text-[#ef4444]')
          }
        >
          {toast.text}
        </div>
      )}
    </div>
  )
}
