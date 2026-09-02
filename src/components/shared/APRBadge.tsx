import { cn, formatAPR } from '@/lib/utils'

interface APRBadgeProps {
  apr: number
  size?: 'sm' | 'md' | 'lg'
  tone?: 'auto' | 'green' | 'yellow' | 'red'
}

export function APRBadge({ apr, size = 'md', tone = 'auto' }: APRBadgeProps) {
  let color = 'text-accent-green bg-accent-green/10 border-accent-green/25'
  if (tone === 'yellow') {
    color = 'text-brand bg-brand/10 border-brand/25'
  } else if (tone === 'red') {
    color = 'text-accent-red bg-accent-red/10 border-accent-red/25'
  }

  const sizing = size === 'sm' ? 'text-micro px-2 py-0.5' : size === 'lg' ? 'text-lead px-3 py-1' : 'text-caption px-2 py-1'

  return (
    <span className={cn('inline-flex items-center border rounded-compact font-mono font-bold tracking-[-0.02em]', color, sizing)}>
      {formatAPR(apr)}
    </span>
  )
}
