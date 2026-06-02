'use client'
import { ReactNode, useEffect } from 'react'
import { X } from 'lucide-react'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
}

export function Modal({ open, onClose, title, children }: ModalProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-md bg-surface border border-line rounded-sm shadow-xl"
      >
        <div className="flex justify-between items-center px-6 py-4 border-b border-line">
          <h3 className="font-mono font-bold text-ink">{title}</h3>
          <button onClick={onClose} className="p-1 hover:bg-surface-2 rounded-sm">
            <X size={18} />
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  )
}
