'use client'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface EarnButtonProps {
  onClick: () => void
  loading?: boolean
  disabled?: boolean
  label?: string
}

export function EarnButton({ onClick, loading, disabled, label = 'Earn upfront now' }: EarnButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={cn(
        'press w-full h-14 font-mono text-body font-semibold rounded-sm flex items-center justify-center gap-2',
        'bg-inverse text-cream hover:shadow-drop',
        (disabled || loading) && 'opacity-50 cursor-not-allowed hover:shadow-none'
      )}
    >
      {loading && <Loader2 size={16} className="animate-spin" />}
      {loading ? 'processing...' : label}
    </button>
  )
}
