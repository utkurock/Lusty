'use client'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ClaimButtonProps {
  onClick: () => void
  loading?: boolean
  disabled?: boolean
}

export function ClaimButton({ onClick, loading, disabled }: ClaimButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={cn(
        'h-10 px-4 bg-[#eab308] text-[#1a1a1a] font-mono text-sm font-semibold rounded-sm',
        'hover:bg-[#eab308]/90 transition flex items-center gap-2',
        (disabled || loading) && 'opacity-50 cursor-not-allowed'
      )}
    >
      {loading && <Loader2 size={14} className="animate-spin" />}
      claim
    </button>
  )
}
