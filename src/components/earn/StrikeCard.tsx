'use client'
import { APRBadge } from '@/components/shared/APRBadge'
import { cn, formatUsdc } from '@/lib/utils'

interface StrikeCardProps {
  index: number
  strike: number
  apr: number
  label: string
  selected: boolean
  onClick: () => void
}

export function StrikeCard({ strike, apr, label, selected, onClick }: StrikeCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative flex flex-col justify-between p-5 rounded-sm transition text-left min-h-[150px]',
        'border-2',
        selected
          ? 'border-[#eab308] bg-[#eab308]/10'
          : 'border-[#c4bfb2] bg-[#f0ece3] hover:border-[#6b6560]'
      )}
    >
      <div className="flex justify-between items-start">
        <span className="font-mono text-[11px] uppercase text-[#6b6560]">Strike</span>
        <APRBadge apr={apr} size="sm" />
      </div>

      <div className="my-2">
        <div className="font-mono text-2xl font-bold text-[#1a1a1a] num">{formatUsdc(strike)}</div>
        <div className="font-mono text-[11px] text-[#6b6560] mt-1">{label}</div>
      </div>

      <div className={cn(
        'font-mono text-xs',
        selected ? 'text-[#eab308] font-semibold' : 'text-[#6b6560]'
      )}>
        {selected ? '● selected' : 'tap to select'}
      </div>
    </button>
  )
}
