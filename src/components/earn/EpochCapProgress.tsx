interface EpochSegment {
  label: string
  utilized: number
  cap: number
  full: boolean
}

interface EpochCapProgressProps {
  utilized: number
  cap: number
  unit?: 'XLM' | 'USD'
  segments: EpochSegment[]
}

/**
 * How much of this side's capacity is already sold, one expiry per bar.
 *
 * The block used to say the same number four ways: a header with the monthly
 * cap, a note with the per-epoch cap, a bar per epoch, a total bar summing
 * them, and two footnotes restating the total as a percentage. The bars are the
 * only part that shows anything the sentence above cannot, so the total is now
 * a line of text and the epochs are the graphic.
 */
export function EpochCapProgress({
  utilized,
  cap,
  unit = 'XLM',
  segments,
}: EpochCapProgressProps) {
  const rawPct = cap > 0 ? (utilized / cap) * 100 : 0
  const full = rawPct >= 100

  const fmt = (n: number) =>
    unit === 'USD'
      ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
      : `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })} XLM`

  return (
    <div className="w-full">
      <div className="flex items-baseline justify-between gap-x-6 gap-y-1 flex-wrap mb-2">
        <div className="label">Capacity</div>
        <div className="font-mono text-tiny text-ink-2">
          <span className="num text-ink font-semibold">{fmt(utilized)}</span> of{' '}
          <span className="num">{fmt(cap)}</span> sold
          {full ? (
            <span className="text-accent-red font-semibold"> — all epochs full</span>
          ) : (
            <span className="num"> · {rawPct.toFixed(1)}%</span>
          )}
        </div>
      </div>

      {/* Bars sit in a sunken well rather than on a bordered plate: the track is
          the surface below the card, so the fill reads as depth, not paint. */}
      {segments.length > 0 && (
        <div className="flex gap-2">
          {segments.map((s, i) => {
            const segPct = s.cap > 0 ? (s.utilized / s.cap) * 100 : 0
            const segBar = Math.min(100, segPct)
            return (
              <div
                key={i}
                className="relative flex-1 h-10 rounded-sm overflow-hidden bg-surface-2"
              >
                <div
                  className={`absolute inset-y-0 left-0 animate-fill transition-all duration-700 ease-std ${s.full ? 'bg-accent-red/85' : 'bg-accent-green/85'}`}
                  style={{ width: `${segBar}%` }}
                />
                <div className="absolute inset-0 flex items-center justify-center gap-2 font-mono">
                  <span className="text-micro uppercase tracking-[0.08em] text-ink font-semibold">
                    {s.label}
                  </span>
                  <span className="num text-micro text-ink-2">
                    {s.full ? 'FULL' : `${segPct.toFixed(0)}%`}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
