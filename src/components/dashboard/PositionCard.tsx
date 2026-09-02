'use client'
import { ClaimButton } from './ClaimButton'
import { formatUsdc, formatXlm, formatExpiry } from '@/lib/utils'

interface PositionCardProps {
  asset: string
  type: 'call' | 'put'
  strike: number
  amount: number
  amountSymbol: string
  premium: number
  expiryDate: Date
  daysLeft: number
  settled: boolean
  txLoading?: boolean
  onClaim: () => void
}

export function PositionCard({
  asset, type, strike, amount, amountSymbol, premium, expiryDate, daysLeft, settled, txLoading, onClaim,
}: PositionCardProps) {
  return (
    <div className="light-card rounded-sm p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-inverse text-brand font-mono font-bold rounded-full flex items-center justify-center">
            {asset[0]}
          </div>
          <div>
            <div className="font-mono font-semibold text-ink">{asset}</div>
            <div className="font-mono text-caption text-ink-2">
              {type === 'call' ? 'Covered Call' : 'Cash Secured Put'}
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="label">Expiry</div>
          <div className="font-mono text-body text-ink">{formatExpiry(expiryDate)}</div>
          <div className="font-mono text-tiny text-ink-2">
            {daysLeft > 0 ? `in ${daysLeft}d` : 'expired'}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 pt-4 border-t border-line">
        <div>
          <div className="label">Strike</div>
          <div className="num font-bold text-ink">${strike.toFixed(4)}</div>
        </div>
        <div>
          <div className="label">Deposited</div>
          <div className="num font-bold text-ink">
            {amountSymbol === 'USDC' ? formatUsdc(amount) : formatXlm(amount)}
          </div>
        </div>
        <div>
          <div className="label">Premium</div>
          <div className="num font-bold text-accent-green">{formatUsdc(premium)}</div>
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <ClaimButton onClick={onClaim} loading={txLoading} disabled={!settled && daysLeft > 0} />
      </div>
    </div>
  )
}
