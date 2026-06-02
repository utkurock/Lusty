'use client'
import { useEffect } from 'react'
import { X, Loader2, ExternalLink } from 'lucide-react'
import { useWalletContext } from '@/providers/WalletProvider'

export function WalletConnectModal() {
  const { modalOpen, closeModal, supportedWallets, selectWallet, loading } =
    useWalletContext()

  // Esc to close
  useEffect(() => {
    if (!modalOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [modalOpen, closeModal])

  if (!modalOpen) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        onClick={closeModal}
        className="absolute inset-0 bg-inverse/70 backdrop-blur-[2px]"
      />

      {/* Modal */}
      <div className="relative w-full max-w-md terminal-card rounded-sm overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="px-5 py-4 border-b border-line-2 flex items-center justify-between">
          <div>
            <div className="font-mono text-[11px] text-[#eab308] uppercase tracking-wider">
              ~/connect
            </div>
            <div className="font-mono text-base text-cream font-bold mt-0.5">
              Choose a wallet
            </div>
          </div>
          <button
            onClick={closeModal}
            className="w-8 h-8 rounded-sm flex items-center justify-center text-cream/60 hover:text-cream hover:bg-line-2 transition"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Wallet list */}
        <div className="bg-card divide-y divide-line divide-dashed">
          {supportedWallets.length === 0 && (
            <div className="px-5 py-6 font-mono text-xs text-ink-2 text-center">
              Loading wallets…
            </div>
          )}
          {supportedWallets.map((w) => {
            const available = w.isAvailable
            return (
              <button
                key={w.id}
                disabled={!available || loading}
                onClick={() => {
                  if (available) selectWallet(w.id)
                  else window.open(w.url, '_blank', 'noopener,noreferrer')
                }}
                className={
                  'w-full flex items-center gap-3 px-5 py-4 transition text-left group ' +
                  (available
                    ? 'hover:bg-surface cursor-pointer'
                    : 'cursor-pointer opacity-70 hover:opacity-100')
                }
              >
                {w.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={w.icon}
                    alt={w.name}
                    className="w-9 h-9 rounded-sm bg-inverse p-1 shrink-0"
                  />
                ) : (
                  <div className="w-9 h-9 rounded-sm bg-inverse text-[#eab308] font-mono font-bold flex items-center justify-center shrink-0">
                    {w.name[0]}
                  </div>
                )}

                <div className="flex-1 min-w-0">
                  <div className="font-mono text-sm font-semibold text-ink truncate">
                    {w.name}
                  </div>
                  <div className="font-mono text-[11px] text-ink-2">
                    {available ? w.type : 'Not installed'}
                  </div>
                </div>

                {!available && (
                  <div className="flex items-center gap-1 text-[11px] font-mono text-[#eab308]">
                    install
                    <ExternalLink size={11} />
                  </div>
                )}
              </button>
            )
          })}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-line bg-surface flex items-center justify-between font-mono text-[11px] text-ink-2">
          <span>Stellar testnet only</span>
          {loading && (
            <span className="flex items-center gap-1.5 text-ink">
              <Loader2 size={12} className="animate-spin" />
              connecting…
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
