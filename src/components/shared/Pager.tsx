'use client'
import { ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * Numbered pagination: arrows around a run of page chips.
 *
 * Numbers rather than a range label, because a short list paged five at a time
 * is one someone reads back and forth — "page 3" is a place you can return to,
 * "11–15 of 25" is only a description of where you happen to be. Past seven
 * pages the run is windowed around the current one so the row never wraps.
 */
export function Pager({
  page,
  pageCount,
  onChange,
  className = '',
}: {
  /** Zero-based. */
  page: number
  pageCount: number
  onChange: (page: number) => void
  className?: string
}) {
  if (pageCount <= 1) return null

  const window = 7
  let from = 0
  let to = pageCount
  if (pageCount > window) {
    from = Math.min(Math.max(0, page - 3), pageCount - window)
    to = from + window
  }
  const pages = Array.from({ length: to - from }, (_, i) => from + i)

  const arrow =
    'press w-8 h-8 flex items-center justify-center rounded-sm border border-line bg-card text-ink hover:bg-raised disabled:opacity-30 disabled:cursor-not-allowed transition'

  return (
    <div className={`flex items-center justify-center gap-2 ${className}`}>
      <button
        onClick={() => onChange(Math.max(0, page - 1))}
        disabled={page === 0}
        className={arrow}
        aria-label="Previous page"
      >
        <ChevronLeft size={14} />
      </button>

      <div className="segmented" role="tablist">
        {pages.map((p) => (
          <button
            key={p}
            role="tab"
            aria-selected={p === page}
            aria-label={`Page ${p + 1}`}
            onClick={() => onChange(p)}
            className="press press-sm num"
          >
            {p + 1}
          </button>
        ))}
      </div>

      <button
        onClick={() => onChange(Math.min(pageCount - 1, page + 1))}
        disabled={page >= pageCount - 1}
        className={arrow}
        aria-label="Next page"
      >
        <ChevronRight size={14} />
      </button>
    </div>
  )
}
