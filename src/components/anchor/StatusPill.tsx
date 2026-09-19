import { cn } from '@/lib/utils'

/** SEP-6 statuses, said in words, with the tone the state deserves. */
const TONE: Record<string, { text: string; className: string }> = {
  incomplete: { text: 'not started', className: '' },
  pending_user_transfer_start: { text: 'waiting for you', className: 'border-accent-yellow/40 text-brand' },
  pending_user_transfer_complete: { text: 'transfer sent', className: '' },
  pending_external: { text: 'waiting on the bank', className: '' },
  pending_anchor: { text: 'anchor is working', className: '' },
  pending_stellar: { text: 'paying on stellar', className: '' },
  pending_trust: { text: 'needs a trustline', className: 'border-accent-yellow/40 text-brand' },
  pending_customer_info_update: { text: 'needs kyc', className: 'border-accent-yellow/40 text-brand' },
  completed: { text: 'completed', className: 'border-accent-green/40 text-accent-green' },
  refunded: { text: 'refunded', className: '' },
  expired: { text: 'expired', className: 'border-accent-red/40 text-accent-red' },
  error: { text: 'error', className: 'border-accent-red/40 text-accent-red' },
}

export function StatusPill({ status }: { status: string }) {
  const tone = TONE[status] ?? { text: status.replace(/_/g, ' '), className: '' }
  return <span className={cn('chip', tone.className)}>{tone.text}</span>
}
