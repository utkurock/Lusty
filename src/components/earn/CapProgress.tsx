interface CapProgressProps {
  utilized: number
  cap: number
}

export function CapProgress({ utilized, cap }: CapProgressProps) {
  const pct = cap > 0 ? Math.min(100, (utilized / cap) * 100) : 0
  return (
    <div className="w-full">
      <div className="relative h-10 bg-[#f0ece3] border border-[#c4bfb2] rounded-sm overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 bg-[#22c55e] animate-fill transition-all duration-700"
          style={{ width: `${pct}%` }}
        />
        <div className="absolute inset-0 flex items-center justify-center font-mono text-sm font-semibold text-[#1a1a1a]">
          {pct.toFixed(2)}% of cap sold
        </div>
      </div>
      <div className="flex justify-between mt-2 font-mono text-xs text-[#6b6560]">
        <span className="num">{utilized.toLocaleString()} / {cap.toLocaleString()} XLM</span>
        <span>updates every epoch</span>
      </div>
    </div>
  )
}
