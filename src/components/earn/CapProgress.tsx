interface CapProgressProps {
  utilized: number
  cap: number
}

export function CapProgress({ utilized, cap }: CapProgressProps) {
  // True utilization for the label; the bar width is clamped to 100% so a
  // full/over-full vault doesn't overflow the track. Keeping the label
  // unclamped means the text and the "X / Y XLM" readout below can never
  // disagree (the old code clamped both and could show "100.00%" next to a
  // raw figure many times the cap).
  const rawPct = cap > 0 ? (utilized / cap) * 100 : 0
  const barPct = Math.min(100, rawPct)
  const full = rawPct >= 100
  return (
    <div className="w-full">
      <div className="relative h-10 bg-[#f0ece3] border border-[#c4bfb2] rounded-sm overflow-hidden">
        <div
          className={`absolute inset-y-0 left-0 animate-fill transition-all duration-700 ${full ? 'bg-[#ef4444]' : 'bg-[#22c55e]'}`}
          style={{ width: `${barPct}%` }}
        />
        <div className="absolute inset-0 flex items-center justify-center font-mono text-sm font-semibold text-[#1a1a1a]">
          {rawPct.toFixed(2)}% of cap sold{full ? ' — vault full' : ''}
        </div>
      </div>
      <div className="flex justify-between mt-2 font-mono text-xs text-[#6b6560]">
        <span className="num">{utilized.toLocaleString()} / {cap.toLocaleString()} XLM</span>
        <span>updates every epoch</span>
      </div>
    </div>
  )
}
