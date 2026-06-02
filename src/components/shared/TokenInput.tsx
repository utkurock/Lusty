'use client'
import { ChangeEvent, ReactNode } from 'react'

interface TokenInputProps {
  value: string
  onChange: (value: string) => void
  symbol: string
  balance?: number
  onMax?: () => void
  label?: string
  min?: number
  max?: number
  usdValue?: number
  symbolSlot?: ReactNode
}

export function TokenInput({
  value,
  onChange,
  symbol,
  balance,
  onMax,
  label,
  min,
  max,
  usdValue,
  symbolSlot,
}: TokenInputProps) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    let v = e.target.value.replace(/[^0-9.]/g, '')
    // Allow only one decimal point
    const parts = v.split('.')
    if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('')
    // Hard clamp at max — can't type past it
    if (max !== undefined && v !== '' && v !== '.') {
      const n = parseFloat(v)
      if (!isNaN(n) && n > max) v = String(max)
    }
    onChange(v)
  }

  const num = parseFloat(value) || 0
  const belowMin = min !== undefined && num > 0 && num < min
  const aboveMax = max !== undefined && num > max

  return (
    <div className="w-full">
      {label && (
        <div className="flex justify-between items-baseline mb-2">
          <label className="font-mono text-xs uppercase text-ink-2">{label}</label>
          {balance !== undefined && (
            <span className="font-mono text-xs text-ink-2">
              balance: <span className="num text-ink">{balance.toLocaleString()}</span>
            </span>
          )}
        </div>
      )}
      <div
        className={`flex items-center gap-2 bg-card border rounded-sm p-4 ${
          belowMin || aboveMax ? 'border-[#ef4444]' : 'border-line'
        }`}
      >
        <input
          type="text"
          inputMode="decimal"
          value={value}
          onChange={handleChange}
          placeholder="0.00"
          className="flex-1 bg-transparent outline-none font-mono text-2xl text-ink placeholder-line"
        />
        {(onMax || max !== undefined) && (
          <button
            type="button"
            onClick={() => {
              if (onMax) onMax()
              else if (max !== undefined) onChange(String(max))
            }}
            className="font-mono text-xs px-2 py-1 border border-line rounded-sm hover:bg-surface"
          >
            max
          </button>
        )}
        {symbolSlot ?? (
          <div className="font-mono text-sm font-semibold text-ink">{symbol}</div>
        )}
      </div>

      <div className="flex justify-between mt-2 font-mono text-[10px] text-ink-2">
        <span>
          {min !== undefined && max !== undefined && (
            <>
              min <span className="text-ink">{min.toLocaleString()}</span>
              {' · '}
              max <span className="text-ink">{max.toLocaleString()}</span> {symbol}
            </>
          )}
        </span>
        <span>
          {usdValue !== undefined && num > 0 && (
            <>≈ ${usdValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}</>
          )}
        </span>
      </div>

      {(belowMin || aboveMax) && (
        <div className="mt-1 font-mono text-[10px] text-[#ef4444]">
          {belowMin
            ? `minimum deposit is ${min!.toLocaleString()} ${symbol}`
            : `maximum deposit is ${max!.toLocaleString()} ${symbol}`}
        </div>
      )}
    </div>
  )
}
