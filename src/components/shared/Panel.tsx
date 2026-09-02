import { ReactNode } from 'react'

interface PanelProps {
  /** Small uppercase name of the panel. */
  title: string
  /** Muted line that sits opposite the title — a caveat, a source, a count. */
  note?: ReactNode
  /** Control that belongs to the panel: a filter, a timeframe, a link. */
  action?: ReactNode
  children: ReactNode
  className?: string
  /** Drop the padding when the body is a table that pads its own rows. */
  flush?: boolean
}

/**
 * A titled card.
 *
 * Every section on the portfolio and leaderboard screens was rebuilding the
 * same header — a label on the left, a muted note or a control on the right,
 * then the body — with slightly different margins each time. This is that
 * header, once, so the panels line up down the page.
 */
export function Panel({ title, note, action, children, className = '', flush }: PanelProps) {
  return (
    <section className={`light-card ${flush ? 'p-0' : 'p-5'} ${className}`}>
      <div
        className={`flex items-baseline justify-between flex-wrap gap-x-6 gap-y-1 ${
          flush ? 'px-5 pt-5 pb-4' : 'mb-4'
        }`}
      >
        <h2 className="label">{title}</h2>
        {action ?? (note ? <div className="font-mono text-tiny text-ink-2">{note}</div> : null)}
      </div>
      {children}
    </section>
  )
}
