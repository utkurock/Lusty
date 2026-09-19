'use client'
import { ChangeEvent, ReactNode } from 'react'
import { fillAmount } from '@/lib/utils'

interface TokenInputProps {
  value: string
  onChange: (value: string) => void
  symbol: string
  /** What the wallet holds, in the asset's own units. Undefined = not read. */
  balance?: number
  /**
   * What the wallet can actually part with — the balance minus the account
   * reserve. `max` bounds what the vault will write; this bounds what the
   * account can pay, and the button honours the smaller of the two.
   */
  spendable?: number
  /**
   * The code the balance is denominated in, when it is not the code in the
   * field. A put escrows cash whichever stable the picker is showing, so the
   * balance names itself rather than borrowing the field's label.
   */
  balanceSymbol?: string
  /** No trustline, or an unfunded account: nothing to spend, for a reason. */
  balanceMissing?: boolean
  onMax?: () => void
  label?: string
  min?: number
  max?: number
  usdValue?: number
  symbolSlot?: ReactNode
  /** How many decimals this asset is worth showing. Two reads 0.001 as zero. */
  decimals?: number
}

export function TokenInput({
  value,
  onChange,
  symbol,
  balance,
  spendable,
  balanceSymbol,
  balanceMissing,
  onMax,
  label,
  min,
  max,
  usdValue,
  symbolSlot,
  decimals = 2,
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

  // What the account can pay. Undefined while the balance has not been read —
  // which is not the same as zero, and must not colour the field red or cap
  // the button at nothing.
  const affordable = spendable ?? balance
  // Typing past the balance is not clamped the way typing past the vault's cap
  // is: the cap is a rule of the venue and cannot change while the field is
  // open, whereas a wallet can be topped up in the next tab. So it is said,
  // not enforced.
  const aboveBalance = affordable !== undefined && num > affordable
  // The button is the promise "this is the most that can happen here", so it
  // honours both bounds at once.
  const maxFillable =
    max !== undefined && affordable !== undefined
      ? Math.min(max, affordable)
      : (max ?? affordable)

  /** Fill a fraction of what "max" would fill. */
  const fill = (fraction: number) => {
    if (maxFillable === undefined) return
    onChange(String(fillAmount(maxFillable, fraction, decimals)))
  }

  return (
    <div className="w-full">
      {label && (
        <div className="flex justify-between items-baseline mb-2">
          <label className="label">{label}</label>
          {balanceMissing ? (
            <span className="font-mono text-caption text-ink-2">
              no {balanceSymbol ?? symbol} in wallet
            </span>
          ) : (
            balance !== undefined && (
              <span className="font-mono text-caption text-ink-2">
                balance:{' '}
                <span className="num text-ink">
                  {balance.toLocaleString(undefined, { maximumFractionDigits: decimals })}
                </span>{' '}
                {balanceSymbol ?? symbol}
              </span>
            )
          )}
        </div>
      )}
      {/* The field is a well, and focus lifts it: the ring lands on the wrapper
          rather than the bare input, so the whole control answers the caret. */}
      <div
        className={`flex items-center gap-2 bg-card border rounded-sm p-4 transition-colors duration-fast ease-std focus-within:border-brand ${
          belowMin || aboveMax || aboveBalance ? 'border-accent-red' : 'border-line-light'
        }`}
      >
        <input
          type="text"
          inputMode="decimal"
          value={value}
          onChange={handleChange}
          placeholder="0.00"
          className="flex-1 bg-transparent outline-none focus-visible:outline-none focus-visible:shadow-none font-mono text-head-md text-ink placeholder-ink-faint/50"
        />
        {maxFillable !== undefined && (
          <button
            type="button"
            onClick={() => fill(0.5)}
            className="press font-mono text-caption px-2 py-1 border border-line rounded-sm hover:bg-raised"
          >
            50%
          </button>
        )}
        {(onMax || maxFillable !== undefined) && (
          <button
            type="button"
            onClick={() => {
              if (onMax) onMax()
              else fill(1)
            }}
            className="press font-mono text-caption px-2 py-1 border border-line rounded-sm hover:bg-raised"
          >
            max
          </button>
        )}
        {symbolSlot ?? (
          <div className="font-mono text-body font-semibold text-ink">{symbol}</div>
        )}
      </div>

      <div className="flex justify-between mt-2 font-mono text-micro text-ink-2">
        <span>
          {min !== undefined && max !== undefined && (
            <>
              min <span className="text-ink">{min.toLocaleString(undefined, { maximumFractionDigits: decimals })}</span>
              {' · '}
              max <span className="text-ink">{max.toLocaleString(undefined, { maximumFractionDigits: decimals })}</span> {symbol}
            </>
          )}
        </span>
        <span>
          {usdValue !== undefined && num > 0 && (
            <>≈ ${usdValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}</>
          )}
        </span>
      </div>

      {(belowMin || aboveMax || aboveBalance) && (
        <div className="mt-1 font-mono text-micro text-accent-red">
          {belowMin
            ? `minimum deposit is ${min!.toLocaleString(undefined, { maximumFractionDigits: decimals })} ${symbol}`
            : aboveMax
              ? `maximum deposit is ${max!.toLocaleString(undefined, { maximumFractionDigits: decimals })} ${symbol}`
              : `wallet holds ${affordable!.toLocaleString(undefined, { maximumFractionDigits: decimals })} ${balanceSymbol ?? symbol} available to deposit`}
        </div>
      )}
    </div>
  )
}
