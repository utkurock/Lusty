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
  label: string
  segments: EpochSegment[]
}

export function EpochCapProgress({
  utilized,
  cap,
  unit = 'XLM',
  label,
  segments,
}: EpochCapProgressProps) {
  const rawPct = cap > 0 ? (utilized / cap) * 100 : 0
  const barPct = Math.min(100, rawPct)
  const full = rawPct >= 100

  const fmt = (n: number) =>
    unit === 'USD'
      ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
      : `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })} XLM`

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-1">
        <div className="font-mono text-xs uppercase text-ink-2">
          Monthly capacity · {fmt(cap)} · {label}
        </div>
        <div className="font-mono text-xs text-ink-2">
          {segments.length} epochs open · each {fmt(cap / Math.max(1, segments.length))}
        </div>
      </div>

      {segments.length > 0 && (
        <div className="flex gap-1.5 mb-2">
          {segments.map((s, i) => {
            const segPct = s.cap > 0 ? (s.utilized / s.cap) * 100 : 0
            const segBar = Math.min(100, segPct)
            return (
              <div
                key={i}
                className="relative flex-1 h-12 rounded-sm border border-line overflow-hidden bg-card"
              >
                <div
                  className={`absolute inset-y-0 left-0 transition-all duration-700 ${s.full ? 'bg-[#ef4444]' : 'bg-[#22c55e]'}`}
                  style={{ width: `${segBar}%` }}
                />
                <div className="absolute inset-0 flex flex-col items-center justify-center font-mono leading-tight">
                  <span className="text-[10px] uppercase text-ink font-semibold">
                    Epoch {i + 1} · {s.label}
                  </span>
                  <span className="num text-[10px] text-ink">
                    {s.full ? 'FULL' : `${segPct.toFixed(0)}%`}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="relative h-10 bg-card border border-line rounded-sm overflow-hidden">
        <div
          className={`absolute inset-y-0 left-0 animate-fill transition-all duration-700 ${full ? 'bg-[#ef4444]' : 'bg-[#22c55e]'}`}
          style={{ width: `${barPct}%` }}
        />
        <div className="absolute inset-0 flex items-center justify-center font-mono text-sm font-semibold text-ink">
          {fmt(utilized)} / {fmt(cap)} sold{full ? ' — all epochs full' : ''}
        </div>
      </div>

      <div className="flex justify-between mt-2 font-mono text-xs text-ink-2">
        <span className="num">{rawPct.toFixed(2)}% of monthly capacity</span>
        <span>combined across {segments.length || '—'} epochs</span>
      </div>
    </div>
  )
}
