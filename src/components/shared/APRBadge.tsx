import { cn, formatAPR } from '@/lib/utils'

interface APRBadgeProps {
  apr: number
  size?: 'sm' | 'md' | 'lg'
  tone?: 'auto' | 'green' | 'yellow' | 'red'
}

export function APRBadge({ apr, size = 'md', tone = 'auto' }: APRBadgeProps) {
  let color = 'text-[#22c55e] bg-[#22c55e]/10 border-[#22c55e]/30'
  if (tone === 'yellow') {
    color = 'text-[#eab308] bg-[#eab308]/10 border-[#eab308]/30'
  } else if (tone === 'red') {
    color = 'text-[#ef4444] bg-[#ef4444]/10 border-[#ef4444]/30'
  }

  const sizing = size === 'sm' ? 'text-xs px-2 py-0.5' : size === 'lg' ? 'text-lg px-3 py-1' : 'text-sm px-2 py-1'

  return (
    <span className={cn('inline-flex items-center border rounded-sm font-mono font-bold', color, sizing)}>
      {formatAPR(apr)}
    </span>
  )
}
