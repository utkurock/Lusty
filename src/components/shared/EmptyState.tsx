import { ReactNode } from 'react'
import { LucideIcon } from 'lucide-react'

interface EmptyStateProps {
  icon: LucideIcon
  /** One line saying what is not here. */
  title: string
  /** Optional second line saying why, or what fills it. */
  hint?: ReactNode
  /** The way out — a link or a button. */
  action?: ReactNode
  className?: string
}

/**
 * The empty state: a plaque, a line, and the way out.
 *
 * Nested rounded squares rather than a bare icon, because a lone glyph in a
 * large panel reads as a rendering failure. The plaque gives it a footprint
 * that says the space is intentionally empty.
 */
export function EmptyState({ icon: Icon, title, hint, action, className = '' }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center text-center py-14 px-6 ${className}`}>
      <div className="rounded-lg border border-line-light p-2 mb-5">
        <div className="w-14 h-14 rounded-sm bg-surface-2 flex items-center justify-center">
          <Icon size={20} className="text-ink-faint" />
        </div>
      </div>
      <div className="font-mono text-body text-ink-2 max-w-sm">{title}</div>
      {hint && (
        <div className="font-mono text-caption text-ink-faint max-w-sm mt-1.5">{hint}</div>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
