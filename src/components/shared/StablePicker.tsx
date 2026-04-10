'use client'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'

export type Stable = 'LUSD' | 'USDC'

export const STABLES: { code: Stable; icon: string }[] = [
  { code: 'LUSD', icon: '/lusd.png' },
  { code: 'USDC', icon: '/usdc.png' },
]

interface StablePickerProps {
  value: Stable
  onChange: (v: Stable) => void
}

export function StablePicker({ value, onChange }: StablePickerProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const active = STABLES.find((s) => s.code === value) ?? STABLES[0]

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 font-mono text-sm font-semibold text-[#1a1a1a] hover:text-[#eab308] transition"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={active.icon} alt={active.code} className="w-5 h-5 rounded-full" />
        {active.code}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 min-w-[120px] rounded-sm border border-[#c4bfb2] bg-[#f0ece3] shadow-md py-1">
          {STABLES.map((s) => (
            <button
              key={s.code}
              onClick={() => {
                onChange(s.code)
                setOpen(false)
              }}
              className={
                'w-full flex items-center gap-2 text-left px-3 py-1.5 font-mono text-xs transition ' +
                (s.code === value
                  ? 'bg-[#1a1a1a] text-[#eab308]'
                  : 'text-[#1a1a1a] hover:bg-[#e8e4d9]')
              }
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.icon} alt={s.code} className="w-4 h-4 rounded-full" />
              {s.code}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
