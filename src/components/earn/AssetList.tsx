'use client'
import { ReactNode, useEffect, useState } from 'react'
import { AssetRow } from './AssetRow'
import { cn } from '@/lib/utils'
import { useVaultStats } from '@/hooks/useVaultStats'
import { upcomingExpiryDates } from '@/lib/expiries'
import { fetchLadder } from '@/lib/quote-client'

export type Tab = 'calls' | 'puts'

interface AssetListProps {
  tab: Tab
  onTabChange: (tab: Tab) => void
  /** This side's remaining capacity. It lives inside the section because the
      tab above chooses which side it describes. */
  capacity?: ReactNode
}

// How long the headline range may keep a placeholder on screen. A healthy
// quote answers in under five seconds; a blocked one takes about twelve to
// fail, and nobody should watch a skeleton for that long to learn nothing.
const QUOTE_DEADLINE_MS = 9_000

interface AprRange {
  max: number
  min: number
}

export function AssetList({ tab, onTabChange, capacity }: AssetListProps) {
  const { stats } = useVaultStats()

  // Real APR range from the quote engine (same engine that pays the premium),
  // not hardcoded. APR rises with tenor and with proximity to spot, so the full
  // offered range spans two corners:
  //   MAX = longest expiry, nearest strike   (highest yield on offer)
  //   MIN = shortest expiry, deepest OTM      (lowest/safest yield on offer)
  const [callApr, setCallApr] = useState<AprRange | undefined>()
  const [putApr, setPutApr] = useState<AprRange | undefined>()
  // Whether the quote engine has answered for each side yet. Without this, an
  // APR that is still on its way and one the engine could not produce render
  // the same way, and the placeholder never resolves into anything.
  //
  // Per side, not one flag for both: the two sides are quoted independently and
  // the screen only ever shows one of them, so making the visible tab wait on
  // the hidden one is a placeholder held up by a request nobody is looking at.
  const [answered, setAnswered] = useState({ call: false, put: false })

  useEffect(() => {
    let cancelled = false
    // Quote by expiry, so the range advertised here is priced against the same
    // tenor AND the same pool utilization the earn screen and the co-signature
    // use. Asking by `days` alone quoted an empty pool, which overstated the
    // headline as the vault filled up.
    const dates = upcomingExpiryDates()
    const shortExpiry = dates[0].toISOString()
    const longExpiry = dates[dates.length - 1].toISOString()

    const ladder = async (side: 'call' | 'put', expiry: string): Promise<number[] | undefined> => {
      try {
        // The headline range is a summary, not the money path — it is worth
        // less than a placeholder that sits there. An upstream the engine
        // cannot reach takes about twelve seconds to give up, so waiting for
        // that is waiting to be told nothing.
        const signal = AbortSignal.timeout(QUOTE_DEADLINE_MS)
        const aprs = (await fetchLadder(side, expiry, signal)).strikes.map((s) => s.apr)
        return aprs.length > 0 ? aprs : undefined
      } catch {
        return undefined
      }
    }
    const range = async (side: 'call' | 'put'): Promise<AprRange | undefined> => {
      const [longL, shortL] = await Promise.all([ladder(side, longExpiry), ladder(side, shortExpiry)])
      if (!longL || !shortL) return undefined
      return { max: Math.max(...longL), min: Math.min(...shortL) }
    }

    range('call').then((r) => {
      if (cancelled) return
      setCallApr(r)
      setAnswered((a) => ({ ...a, call: true }))
    })
    range('put').then((r) => {
      if (cancelled) return
      setPutApr(r)
      setAnswered((a) => ({ ...a, put: true }))
    })

    return () => {
      cancelled = true
    }
  }, [])

  // Only block the entry point when every open expiry is full.
  const callsFull =
    !!stats &&
    stats.buckets.length > 0 &&
    stats.buckets.every((b) => b.callFull)
  const putsFull =
    !!stats &&
    stats.buckets.length > 0 &&
    stats.buckets.every((b) => b.putFull)

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="font-mono text-body text-ink-2">~/assets</div>
        {/* Segmented control: the track is the sunken surface, the selected
            side is the raised one. Only the chip moves, the strip does not. */}
        <div
          role="tablist"
          className="inline-flex gap-1 p-1 rounded-sm bg-surface-2"
        >
          {([
            ['calls', 'covered calls'],
            ['puts', 'cash secured puts'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={tab === value}
              onClick={() => onTabChange(value)}
              className={cn(
                'press press-sm font-mono text-caption px-3 py-1.5 rounded-inner',
                tab === value
                  ? 'bg-brand text-ink shadow-button'
                  : 'text-ink-2 hover:text-ink'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {capacity && <div className="mb-6">{capacity}</div>}

      <div className="space-y-2">
        <div className="hidden md:grid grid-cols-12 px-5 label">
          <div className="col-span-4">Asset</div>
          <div className="col-span-3">Type</div>
          <div className="col-span-2">Max APR</div>
          <div className="col-span-1">Min APR</div>
          <div className="col-span-2 text-right">Action</div>
        </div>

        {tab === 'calls' ? (
          <AssetRow
            symbol="XLM"
            name="Stellar Lumens"
            type="Covered Call"
            maxAPR={callApr?.max}
            minAPR={callApr?.min}
            quoted={answered.call}
            href="/earn/xlm"
            disabled={callsFull}
            disabledReason="Vault full"
          />
        ) : (
          <AssetRow
            symbol="XLM"
            name="Stellar Lumens"
            type="Cash Secured Put"
            maxAPR={putApr?.max}
            minAPR={putApr?.min}
            quoted={answered.put}
            href="/earn/xlm?type=put"
            disabled={putsFull}
            disabledReason="Vault full"
          />
        )}

        {/* The engine answered and had nothing to offer. Say so once, under the
            row, rather than leaving two columns of dashes to be read as zero
            yield — and keep the row itself navigable, because the strike screen
            reports the reason in full. */}
        {(tab === 'calls' ? answered.call : answered.put) &&
          !(tab === 'calls' ? callApr : putApr) && (
          <div className="notice notice-quiet">
            Live pricing is unavailable right now, so the offered range cannot be
            shown. Open the asset to see what the quote engine reports.
          </div>
        )}
      </div>
    </div>
  )
}
