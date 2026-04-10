'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowRight } from 'lucide-react'
import { formatAPR } from '@/lib/utils'

interface AssetRowProps {
  symbol: string
  name: string
  type: string
  maxAPR: number
  minAPR: number
  href: string
}

export function AssetRow({ symbol, name, type, maxAPR, minAPR, href }: AssetRowProps) {
  const router = useRouter()
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => router.push(href)}
      onKeyDown={e => { if (e.key === 'Enter') router.push(href) }}
      className="px-4 md:px-6 py-4 md:py-5 dashed-row hover:bg-[#e8e4d9] cursor-pointer transition"
    >
      {/* Desktop grid */}
      <div className="hidden md:grid grid-cols-12 items-center">
        <div className="col-span-4 flex items-center gap-3">
          {symbol === 'XLM' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/xlm.png" alt="XLM" className="w-9 h-9 rounded-full" />
          ) : (
            <div className="w-9 h-9 rounded-full bg-[#1a1a1a] text-[#eab308] font-mono font-bold flex items-center justify-center">
              {symbol[0]}
            </div>
          )}
          <div>
            <div className="font-mono font-semibold text-[#1a1a1a]">{symbol}</div>
            <div className="font-mono text-xs text-[#6b6560]">{name}</div>
          </div>
        </div>
        <div className="col-span-3 font-mono text-sm text-[#1a1a1a]">{type}</div>
        <div className="col-span-2 num text-[#22c55e] font-bold">{formatAPR(maxAPR)}</div>
        <div className="col-span-1 num text-[#22c55e]/70">{formatAPR(minAPR)}</div>
        <div className="col-span-2 flex justify-end">
          <Link
            href={href}
            onClick={e => e.stopPropagation()}
            className="inline-flex items-center gap-2 font-mono text-xs px-3 py-2 bg-[#1a1a1a] text-[#e8e4d9] rounded-sm hover:bg-[#2a2a2a]"
          >
            Earn on {symbol}
            <ArrowRight size={12} />
          </Link>
        </div>
      </div>

      {/* Mobile stacked */}
      <div className="md:hidden">
        <div className="flex items-center gap-3">
          {symbol === 'XLM' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/xlm.png" alt="XLM" className="w-10 h-10 rounded-full" />
          ) : (
            <div className="w-10 h-10 rounded-full bg-[#1a1a1a] text-[#eab308] font-mono font-bold flex items-center justify-center">
              {symbol[0]}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="font-mono font-semibold text-[#1a1a1a]">{symbol}</div>
            <div className="font-mono text-[11px] text-[#6b6560] truncate">{name} · {type}</div>
          </div>
          <div className="text-right shrink-0">
            <div className="num text-[#22c55e] font-bold text-sm">{formatAPR(maxAPR)}</div>
            <div className="font-mono text-[10px] text-[#6b6560] uppercase">max apr</div>
          </div>
        </div>
        <Link
          href={href}
          onClick={e => e.stopPropagation()}
          className="mt-3 flex items-center justify-center gap-2 font-mono text-xs px-3 py-2.5 bg-[#1a1a1a] text-[#e8e4d9] rounded-sm hover:bg-[#2a2a2a] w-full"
        >
          Earn on {symbol}
          <ArrowRight size={12} />
        </Link>
      </div>
    </div>
  )
}
