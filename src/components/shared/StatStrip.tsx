import { ReactNode } from 'react'

export interface Stat {
  label: string
  /** The number itself. Pass a string so the caller keeps control of format. */
  value: ReactNode
  /** Unit or qualifier set beside the value at body size. */
  unit?: string
  /** One muted line under the value. */
  sub?: ReactNode
  /** Tint the value: a gain, a loss, or the brand. */
  tone?: 'ink' | 'green' | 'red' | 'brand'
}

const TONE = {
  ink: 'text-ink',
  green: 'text-accent-green',
  red: 'text-accent-red',
  brand: 'text-brand',
} as const

/**
 * A row of figures divided by hairlines rather than boxed into separate cards.
 *
 * The distinction matters: these numbers describe one thing from several
 * angles, so they belong inside one surface. Giving each its own card said they
 * were unrelated, and left four sets of card padding between four numbers that
 * should be read across in a single glance.
 *
 * A missing value renders as an em dash, never as zero — "not known yet" and
 * "none" are different answers, and on a risk screen the difference is the
 * whole point.
 */
export function StatStrip({
  stats,
  className = '',
  /** Stack into one column — for a narrow rail, where a row would wrap anyway.
      The divider moves with it: a rule above each figure instead of beside. */
  stack = false,
}: {
  stats: Stat[]
  className?: string
  stack?: boolean
}) {
  return (
    <div
      className={`grid ${stack ? 'gap-4' : 'gap-x-6 gap-y-5'} ${className}`}
      style={{
        gridTemplateColumns: stack ? '1fr' : 'repeat(auto-fit, minmax(140px, 1fr))',
      }}
    >
      {stats.map((s, i) => (
        <div
          key={s.label}
          className={
            i === 0
              ? ''
              : stack
                ? 'border-t border-line-light pt-4'
                : 'sm:border-l sm:border-line-light sm:pl-6'
          }
        >
          <div className="label">{s.label}</div>
          <div className={`num text-head-sm font-bold mt-0.5 ${TONE[s.tone ?? 'ink']}`}>
            {s.value ?? '—'}
            {s.unit && (
              <span className="text-body font-normal text-ink-2"> {s.unit}</span>
            )}
          </div>
          {s.sub && <div className="font-mono text-tiny text-ink-2 mt-1">{s.sub}</div>}
        </div>
      ))}
    </div>
  )
}
