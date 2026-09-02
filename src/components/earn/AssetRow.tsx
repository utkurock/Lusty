'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowRight, ChevronRight } from 'lucide-react'
import { formatAPR } from '@/lib/utils'

interface AssetRowProps {
  symbol: string
  name: string
  type: string
  /** Undefined while the live quote is still loading. */
  maxAPR?: number
  minAPR?: number
  href: string
  /** When set, the row is not navigable and the action is shown as disabled. */
  disabled?: boolean
  /** Short reason rendered in place of the APRs when disabled (e.g. cap full). */
  disabledReason?: string
}

export function AssetRow({
  symbol,
  name,
  type,
  maxAPR,
  minAPR,
  href,
  disabled = false,
  disabledReason,
}: AssetRowProps) {
  const router = useRouter()
  const fmt = (v?: number) => (v == null ? '…' : formatAPR(v))
  return (
    <div
      role={disabled ? undefined : 'button'}
      tabIndex={disabled ? undefined : 0}
      onClick={disabled ? undefined : () => router.push(href)}
      onKeyDown={disabled ? undefined : e => { if (e.key === 'Enter') router.push(href) }}
      aria-disabled={disabled || undefined}
      className={
        'light-card px-4 md:px-5 py-4 md:py-0 md:h-[76px] md:flex md:items-center ' +
        (disabled
          ? 'opacity-60 cursor-not-allowed'
          : 'card-interactive cursor-pointer')
      }
    >
      {/* Desktop grid */}
      <div className="hidden md:grid grid-cols-12 items-center w-full">
        <div className="col-span-4 flex items-center gap-3">
          {symbol === 'XLM' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/xlm.png" alt="XLM" className="w-9 h-9 rounded-full" />
          ) : (
            <div className="w-9 h-9 rounded-full bg-inverse text-brand font-mono font-bold flex items-center justify-center">
              {symbol[0]}
            </div>
          )}
          <div>
            <div className="font-display text-lead text-ink">{symbol}</div>
            <div className="font-mono text-caption text-ink-2">{name}</div>
            <div className="flex gap-1.5 mt-1">
              <span className="chip">weekly</span>
              <span className="chip">oracle settled</span>
            </div>
          </div>
        </div>
        <div className="col-span-3 font-mono text-body text-ink-2">{type}</div>
        <div className="col-span-2 num text-lead text-accent-green font-bold">{fmt(maxAPR)}</div>
        <div className="col-span-1 num text-body text-accent-green/70">{fmt(minAPR)}</div>
        <div className="col-span-2 flex justify-end items-center gap-2">
          {disabled ? (
            <span
              title={disabledReason}
              className="chip cursor-not-allowed"
            >
              {disabledReason ?? 'Unavailable'}
            </span>
          ) : (
            /* The action is present but quiet until the row is addressed —
               hover or keyboard focus both bring it up. */
            <Link
              href={href}
              onClick={e => e.stopPropagation()}
              className="row-actions press press-sm inline-flex items-center gap-2 font-mono text-caption px-3 py-2 bg-inverse text-cream rounded-sm hover:shadow-button"
            >
              Earn on {symbol}
              <ArrowRight size={12} />
            </Link>
          )}
          <ChevronRight
            size={14}
            className={disabled ? 'text-ink-faint/40' : 'text-ink-faint'}
            aria-hidden
          />
        </div>
      </div>

      {/* Mobile stacked */}
      <div className="md:hidden">
        <div className="flex items-center gap-3">
          {symbol === 'XLM' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/xlm.png" alt="XLM" className="w-10 h-10 rounded-full" />
          ) : (
            <div className="w-10 h-10 rounded-full bg-inverse text-brand font-mono font-bold flex items-center justify-center">
              {symbol[0]}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="font-display text-lead text-ink">{symbol}</div>
            <div className="font-mono text-tiny text-ink-2 truncate">{name} · {type}</div>
          </div>
          <div className="text-right shrink-0">
            <div className="num text-lead text-accent-green font-bold">{fmt(maxAPR)}</div>
            <div className="label">max apr</div>
          </div>
        </div>
        {disabled ? (
          <span
            title={disabledReason}
            className="mt-3 flex items-center justify-center gap-2 font-mono text-caption px-3 py-2.5 bg-surface-2 text-ink-2 rounded-sm cursor-not-allowed w-full"
          >
            {disabledReason ?? 'Unavailable'}
          </span>
        ) : (
          <Link
            href={href}
            onClick={e => e.stopPropagation()}
            className="press mt-3 flex items-center justify-center gap-2 font-mono text-caption px-3 py-2.5 bg-inverse text-cream rounded-sm w-full"
          >
            Earn on {symbol}
            <ArrowRight size={12} />
          </Link>
        )}
      </div>
    </div>
  )
}
