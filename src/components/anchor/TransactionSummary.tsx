import { ExternalLink } from 'lucide-react'
import { assetLabel } from '@/lib/anchor/sep6'
import { EXPLORER_TX } from '@/lib/anchor/chain'
import { StatusPill } from './StatusPill'
import type { AnchorTransaction } from '@/lib/anchor/types'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="dashed-row flex items-baseline justify-between gap-4 py-2 last:border-0">
      <span className="label">{label}</span>
      <span className="num text-body text-ink text-right break-all">{children}</span>
    </div>
  )
}

/**
 * One order, as the anchor currently describes it.
 *
 * The amounts are read off the transaction record rather than recomputed from
 * the quote: what the anchor says it paid is what was paid, and a number this
 * screen derived itself could only ever disagree with the truth.
 */
export function TransactionSummary({ tx }: { tx: AnchorTransaction }) {
  const inAsset = assetLabel(tx.amount_in_asset)
  const outAsset = assetLabel(tx.amount_out_asset)

  return (
    <div className="light-card p-5">
      <div className="flex items-center justify-between gap-4 mb-3">
        <div>
          <div className="label">{tx.kind === 'deposit' ? 'on-ramp' : 'off-ramp'}</div>
          <div className="font-code text-caption text-ink-2 mt-0.5">{tx.id}</div>
        </div>
        <StatusPill status={tx.status} />
      </div>

      {tx.message && <div className="notice notice-quiet mb-3">{tx.message}</div>}

      <div>
        {tx.amount_in && (
          <Row label="you send">
            {tx.amount_in} {inAsset}
          </Row>
        )}
        {tx.amount_fee && (
          <Row label="fee">
            {tx.amount_fee} {assetLabel(tx.amount_fee_asset)}
          </Row>
        )}
        {tx.amount_out && (
          <Row label="you receive">
            {tx.amount_out} {outAsset}
          </Row>
        )}
        {tx.external_transaction_id && <Row label="bank reference">{tx.external_transaction_id}</Row>}
        {tx.to && <Row label="paid to">{tx.to}</Row>}
      </div>

      {(tx.stellar_transaction_id || tx.more_info_url) && (
        <div className="flex flex-wrap gap-4 mt-4 font-mono text-caption">
          {tx.stellar_transaction_id && (
            <a
              href={EXPLORER_TX(tx.stellar_transaction_id)}
              target="_blank"
              rel="noopener noreferrer"
              className="press rounded-sm text-brand inline-flex items-center gap-1"
            >
              stellar transaction <ExternalLink size={12} />
            </a>
          )}
          {tx.more_info_url && (
            <a
              href={tx.more_info_url}
              target="_blank"
              rel="noopener noreferrer"
              className="press rounded-sm text-ink-2 hover:text-ink inline-flex items-center gap-1"
            >
              anchor record <ExternalLink size={12} />
            </a>
          )}
        </div>
      )}
    </div>
  )
}
