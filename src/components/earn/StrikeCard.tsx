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
        /* Selection is a ring, not a second border width: swapping border-2 for
           a shadow ring keeps the card the same size selected or not, so the
           ladder does not shift by 1px as you move across it. */
        'press relative flex flex-col justify-between p-5 rounded-sm text-left min-h-[150px] border',
        selected
          ? 'border-brand bg-brand/10 shadow-[0_0_0_1px_var(--brand)]'
          : 'light-card card-interactive'
      )}
      aria-pressed={selected}
    >
      <div className="flex justify-between items-start">
        <span className="label">Strike</span>
        <APRBadge apr={apr} size="sm" />
      </div>

      <div className="my-2">
        <div className="font-display text-head-md text-ink num">{formatUsdc(strike)}</div>
        <div className="font-mono text-tiny text-ink-2 mt-1">{label}</div>
      </div>

      <div className={cn(
        'font-mono text-caption',
        selected ? 'text-brand font-semibold' : 'text-ink-faint'
      )}>
        {selected ? '● selected' : 'tap to select'}
      </div>
    </button>
  )
}
