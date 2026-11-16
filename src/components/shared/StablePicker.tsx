'use client'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { CASH } from '@/lib/assets'
import { USDC_CODE, USDC_ROUTES_TO_CASH } from '@/lib/usdc'

/** An asset code a put can be paid in. */
export type Stable = string

/** The cash a put escrows, and USDC routed into it unless the cash is USDC. */
export const STABLES: { code: Stable; icon: string }[] = [
  { code: CASH.code, icon: CASH.logo },
  ...(USDC_ROUTES_TO_CASH ? [{ code: USDC_CODE, icon: '/usdc.png' }] : []),
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
        className="press flex items-center gap-1.5 font-mono text-body font-semibold text-ink hover:text-brand transition"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={active.icon} alt={active.code} className="w-5 h-5 rounded-full" />
        {active.code}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 min-w-[120px] raised-card py-1">
          {STABLES.map((s) => (
            <button
              key={s.code}
              onClick={() => {
                onChange(s.code)
                setOpen(false)
              }}
              className={
                'press w-full flex items-center gap-2 text-left px-3 py-1.5 font-mono text-caption transition ' +
                (s.code === value
                  ? 'bg-inverse text-brand'
                  : 'text-ink hover:bg-raised')
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
