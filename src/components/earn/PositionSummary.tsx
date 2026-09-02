import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { cn, formatUsdc, formatXlm, formatAPR, formatExpiry } from '@/lib/utils'

interface PositionSummaryProps {
  premium: number
  apr: number
  xlmAmount: number
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
          If {asset} {direction} ${strike.toFixed(4)}
        </div>
        <div className="num font-semibold text-ink mt-1">{headline}</div>
        <div className="font-mono text-tiny text-ink-faint mt-0.5">{consequence}</div>
      </div>
    </div>
  )
}

export function PositionSummary({
  premium, apr, xlmAmount, strikePrice, expiryDate, type = 'call', usdcAmount,
}: PositionSummaryProps) {
  const usdcIfCalled = xlmAmount * strikePrice
  const xlmIfPut = (usdcAmount ?? 0) / Math.max(strikePrice, 1e-9)

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
                asset="XLM"
                direction="below"
                strike={strikePrice}
                headline={`Get ${formatXlm(xlmAmount)} back`}
                consequence="not called — you keep the XLM"
              />
              <Outcome
                asset="XLM"
                direction="above"
                strike={strikePrice}
                headline={`Receive ${formatUsdc(usdcIfCalled)}`}
                consequence="called — your XLM sells at the strike"
              />
            </>
          ) : (
            <>
              <Outcome
                asset="XLM"
                direction="above"
                strike={strikePrice}
                headline={`Get ${formatUsdc(usdcAmount ?? 0)} back`}
                consequence="not assigned — you keep the collateral"
              />
              <Outcome
                asset="XLM"
                direction="below"
                strike={strikePrice}
                headline={`Receive ${formatXlm(xlmIfPut)}`}
                consequence="assigned — you buy XLM at the strike"
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
