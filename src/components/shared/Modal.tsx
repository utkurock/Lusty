'use client'
import { ReactNode, useEffect } from 'react'
import { X } from 'lucide-react'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  /** 'lg' widens the dialog and scrolls its body, for forms taller than the screen. */
  size?: 'md' | 'lg'
}

export function Modal({ open, onClose, title, children, size = 'md' }: ModalProps) {
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
        className={`w-full raised-card ${size === 'lg' ? 'max-w-2xl' : 'max-w-md'}`}
      >
        <div className="flex justify-between items-center px-6 py-4 border-b border-line-light">
          <h3 className="font-mono text-ink">{title}</h3>
          <button onClick={onClose} className="press p-1 hover:bg-surface-2 rounded-sm">
            <X size={18} />
          </button>
        </div>
        <div className={size === 'lg' ? 'p-6 max-h-[calc(100vh-9rem)] overflow-y-auto' : 'p-6'}>{children}</div>
      </div>
    </div>
  )
}
