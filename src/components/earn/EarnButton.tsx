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
        'w-full h-14 font-mono text-sm font-semibold rounded-sm transition flex items-center justify-center gap-2',
        'bg-[#1a1a1a] text-[#e8e4d9] hover:bg-[#2a2a2a]',
        (disabled || loading) && 'opacity-50 cursor-not-allowed hover:bg-[#1a1a1a]'
      )}
    >
      {loading && <Loader2 size={16} className="animate-spin" />}
      {loading ? 'processing...' : label}
    </button>
  )
}
