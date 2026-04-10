'use client'
import { useEffect, useRef, useState } from 'react'
import { useWalletContext } from '@/providers/WalletProvider'
import { formatAddress } from '@/lib/utils'
import { Loader2, Wallet, Copy, LogOut, ExternalLink, Check } from 'lucide-react'

export function WalletButton() {
  const { address, connected, loading, connect, disconnect } = useWalletContext()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  if (loading) {
    return (
      <button
        disabled
        className="h-10 px-4 bg-[#1a1a1a] text-[#e8e4d9] font-mono text-sm rounded-sm flex items-center gap-2 opacity-80"
      >
        <Loader2 size={14} className="animate-spin" />
        connecting...
      </button>
    )
  }

  if (connected && address) {
    const handleCopy = async () => {
      try {
        await navigator.clipboard.writeText(address)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      } catch {
        /* ignore */
      }
    }

    return (
      <div className="relative" ref={ref}>
        <button
          onClick={() => setOpen((v) => !v)}
          className="h-10 px-4 bg-[#1a1a1a] text-[#e8e4d9] font-mono text-sm rounded-sm flex items-center gap-2 hover:bg-[#2a2a2a] transition"
        >
          <span className="w-2 h-2 bg-[#22c55e] rounded-full" />
          {formatAddress(address)}
        </button>

        {open && (
          <div className="absolute right-0 top-full mt-1 z-30 min-w-[220px] rounded-sm border border-[#c4bfb2] bg-[#f0ece3] shadow-md overflow-hidden">
            <div className="px-4 py-3 border-b border-[#c4bfb2] border-dashed">
              <div className="font-mono text-[10px] uppercase text-[#6b6560] tracking-wider">
                Connected
              </div>
              <div className="font-mono text-xs text-[#1a1a1a] mt-0.5 break-all">
                {formatAddress(address)}
              </div>
            </div>
            <button
              onClick={handleCopy}
              className="w-full flex items-center gap-2 px-4 py-2.5 font-mono text-xs text-[#1a1a1a] hover:bg-[#e8e4d9] transition"
            >
              {copied ? (
                <>
                  <Check size={12} className="text-[#22c55e]" />
                  Copied
                </>
              ) : (
                <>
                  <Copy size={12} />
                  Copy address
                </>
              )}
            </button>
            <a
              href={`https://stellarchain.io/accounts/${address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full flex items-center gap-2 px-4 py-2.5 font-mono text-xs text-[#1a1a1a] hover:bg-[#e8e4d9] transition"
            >
              <ExternalLink size={12} />
              View on explorer
            </a>
            <button
              onClick={() => {
                setOpen(false)
                disconnect()
              }}
              className="w-full flex items-center gap-2 px-4 py-2.5 font-mono text-xs text-[#ef4444] hover:bg-[#ef4444]/10 border-t border-[#c4bfb2] border-dashed transition"
            >
              <LogOut size={12} />
              Disconnect
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <button
      onClick={connect}
      className="h-10 px-4 bg-[#1a1a1a] text-[#e8e4d9] font-mono text-sm rounded-sm flex items-center gap-2 hover:bg-[#2a2a2a] transition"
    >
      <Wallet size={14} />
      connect
    </button>
  )
}
