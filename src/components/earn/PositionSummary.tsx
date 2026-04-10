import { formatUsdc, formatXlm, formatAPR, formatExpiry } from '@/lib/utils'

interface PositionSummaryProps {
  premium: number
  apr: number
  xlmAmount: number
  strikePrice: number
  expiryDate: Date
  type?: 'call' | 'put'
  usdcAmount?: number
}

export function PositionSummary({
  premium, apr, xlmAmount, strikePrice, expiryDate, type = 'call', usdcAmount,
}: PositionSummaryProps) {
  const usdcIfCalled = xlmAmount * strikePrice
  const xlmIfPut = (usdcAmount ?? 0) / Math.max(strikePrice, 1e-9)

  return (
    <div className="light-card rounded-sm overflow-hidden">
      <div className="p-5 border-b border-[#c4bfb2]">
        <div className="font-mono text-[11px] uppercase text-[#6b6560] mb-2">Now</div>
        <div className="flex items-baseline gap-3 flex-wrap">
          <div className="num text-3xl font-bold text-[#1a1a1a]">{formatUsdc(premium)}</div>
          <div className="font-mono text-xs text-[#6b6560]">upfront received</div>
          <div className="ml-auto num font-bold text-[#22c55e]">{formatAPR(apr)} APR</div>
        </div>
      </div>

      <div className="p-5">
        <div className="font-mono text-[11px] uppercase text-[#6b6560] mb-3">
          On {formatExpiry(expiryDate)}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {type === 'call' ? (
            <>
              <div className="p-4 border border-[#c4bfb2] rounded-sm bg-[#e8e4d9]/50">
                <div className="font-mono text-[11px] text-[#6b6560] mb-1">
                  If XLM BELOW ${strikePrice.toFixed(4)}
                </div>
                <div className="num font-semibold text-[#1a1a1a]">
                  Get {formatXlm(xlmAmount)} back
                </div>
              </div>
              <div className="p-4 border border-[#c4bfb2] rounded-sm bg-[#e8e4d9]/50">
                <div className="font-mono text-[11px] text-[#6b6560] mb-1">
                  If XLM ABOVE ${strikePrice.toFixed(4)}
                </div>
                <div className="num font-semibold text-[#1a1a1a]">
                  Receive {formatUsdc(usdcIfCalled)}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="p-4 border border-[#c4bfb2] rounded-sm bg-[#e8e4d9]/50">
                <div className="font-mono text-[11px] text-[#6b6560] mb-1">
                  If XLM ABOVE ${strikePrice.toFixed(4)}
                </div>
                <div className="num font-semibold text-[#1a1a1a]">
                  Get {formatUsdc(usdcAmount ?? 0)} back
                </div>
              </div>
              <div className="p-4 border border-[#c4bfb2] rounded-sm bg-[#e8e4d9]/50">
                <div className="font-mono text-[11px] text-[#6b6560] mb-1">
                  If XLM BELOW ${strikePrice.toFixed(4)}
                </div>
                <div className="num font-semibold text-[#1a1a1a]">
                  Receive {formatXlm(xlmIfPut)}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
