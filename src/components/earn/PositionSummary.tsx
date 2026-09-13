import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { cn, formatUsdc, formatUnits, formatAPR, formatExpiry } from '@/lib/utils'

interface PositionSummaryProps {
  premium: number
  apr: number
  /** Collateral on the call leg, in the underlying's own units. */
  underlyingAmount: number
  /** What that underlying is called, and how many decimals it is worth. */
  assetSymbol: string
  decimals: number
  strikePrice: number
  expiryDate: Date
  type?: 'call' | 'put'
  usdcAmount?: number
}

/**
 * One of the two ways the position can settle.
 *
 * The direction is drawn, not only spelled: an arrow and a tint say which side
 * of the strike this branch is before the sentence is read, and the muted line
 * under the figure says what actually happens to the collateral. Two cards that
 * differ by a single word — BELOW against ABOVE — read as the same card twice.
 */
function Outcome({
  asset,
  direction,
  strike,
  headline,
  consequence,
}: {
  asset: string
  direction: 'above' | 'below'
  strike: number
  headline: string
  consequence: string
}) {
  const up = direction === 'above'
  const Arrow = up ? ArrowUpRight : ArrowDownRight

  return (
    <div className="p-4 rounded-sm bg-surface-2 flex items-start gap-3">
      <span
        className={cn(
          'mt-0.5 shrink-0 w-7 h-7 rounded-inner flex items-center justify-center',
          up
            ? 'bg-accent-green/15 text-accent-green'
            : 'bg-accent-red/15 text-accent-red'
        )}
        aria-hidden
      >
        <Arrow size={14} />
      </span>
      <div className="min-w-0">
        <div className="font-mono text-tiny text-ink-2">
          If {asset} {direction} ${strike.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: strike >= 100 ? 2 : 4,
          })}
        </div>
        <div className="num font-semibold text-ink mt-1">{headline}</div>
        <div className="font-mono text-tiny text-ink-faint mt-0.5">{consequence}</div>
      </div>
    </div>
  )
}

export function PositionSummary({
  premium, apr, underlyingAmount, assetSymbol, decimals, strikePrice,
  expiryDate, type = 'call', usdcAmount,
}: PositionSummaryProps) {
  const usdcIfCalled = underlyingAmount * strikePrice
  const underlyingIfPut = (usdcAmount ?? 0) / Math.max(strikePrice, 1e-9)
  const units = (n: number) => formatUnits(n, assetSymbol, decimals)

  return (
    <div className="light-card rounded-sm overflow-hidden">
      <div className="p-5 border-b border-line-light">
        <div className="label mb-2">Now</div>
        <div className="flex items-baseline gap-3 flex-wrap">
          <div className="num text-3xl font-bold text-ink">{formatUsdc(premium)}</div>
          <div className="font-mono text-caption text-ink-2">upfront received</div>
          <div className="ml-auto num font-bold text-accent-green">{formatAPR(apr)} APR</div>
        </div>
      </div>

      <div className="p-5">
        <div className="label mb-3">
          On {formatExpiry(expiryDate)}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {type === 'call' ? (
            <>
              <Outcome
                asset={assetSymbol}
                direction="below"
                strike={strikePrice}
                headline={`Get ${units(underlyingAmount)} back`}
                consequence={`not called — you keep the ${assetSymbol}`}
              />
              <Outcome
                asset={assetSymbol}
                direction="above"
                strike={strikePrice}
                headline={`Receive ${formatUsdc(usdcIfCalled)}`}
                consequence={`called — your ${assetSymbol} sells at the strike`}
              />
            </>
          ) : (
            <>
              <Outcome
                asset={assetSymbol}
                direction="above"
                strike={strikePrice}
                headline={`Get ${formatUsdc(usdcAmount ?? 0)} back`}
                consequence="not assigned — you keep the collateral"
              />
              <Outcome
                asset={assetSymbol}
                direction="below"
                strike={strikePrice}
                headline={`Receive ${units(underlyingIfPut)}`}
                consequence={`assigned — you buy ${assetSymbol} at the strike`}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
