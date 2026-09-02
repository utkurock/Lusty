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
        className="press h-10 px-4 bg-inverse text-cream font-mono text-body rounded-sm flex items-center gap-2 opacity-80"
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
          className="press h-10 px-4 bg-inverse text-cream font-mono text-body rounded-sm flex items-center gap-2 hover:bg-line-2 transition"
        >
          <span className="w-2 h-2 bg-accent-green rounded-full" />
          {formatAddress(address)}
        </button>

        {open && (
          <div className="absolute right-0 top-full mt-1 z-30 min-w-[220px] raised-card overflow-hidden">
            <div className="px-4 py-3 border-b border-line border-dashed">
              <div className="label">
                Connected
              </div>
              <div className="font-mono text-caption text-ink mt-0.5 break-all">
                {formatAddress(address)}
              </div>
            </div>
            <button
              onClick={handleCopy}
              className="press w-full flex items-center gap-2 px-4 py-2.5 font-mono text-caption text-ink hover:bg-raised transition"
            >
              {copied ? (
                <>
                  <Check size={12} className="text-accent-green" />
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
              className="w-full flex items-center gap-2 px-4 py-2.5 font-mono text-caption text-ink hover:bg-raised transition"
            >
              <ExternalLink size={12} />
              View on explorer
            </a>
            <button
              onClick={() => {
                setOpen(false)
                disconnect()
              }}
              className="press w-full flex items-center gap-2 px-4 py-2.5 font-mono text-caption text-accent-red hover:bg-accent-red/10 border-t border-line border-dashed transition"
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
      className="press h-10 px-4 bg-inverse text-cream font-mono text-body rounded-sm flex items-center gap-2 hover:bg-line-2 transition"
    >
      <Wallet size={14} />
      connect
    </button>
  )
}
