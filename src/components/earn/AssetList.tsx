'use client'
import { useEffect, useState } from 'react'
import { AssetRow } from './AssetRow'
import { EpochCapProgress } from './EpochCapProgress'
import { cn } from '@/lib/utils'
import { useVaultStats } from '@/hooks/useVaultStats'
import { upcomingExpiryDates } from '@/lib/expiries'
import { fetchLadder } from '@/lib/quote-client'
import { enabledUnderlyings, type UnderlyingAsset } from '@/lib/assets'

export type Tab = 'calls' | 'puts'

interface AssetListProps {
  tab: Tab
  onTabChange: (tab: Tab) => void
}

// How long the headline range may keep a placeholder on screen. A healthy
// quote answers in under five seconds; a blocked one takes about twelve to
// fail, and nobody should watch a skeleton for that long to learn nothing.
const QUOTE_DEADLINE_MS = 9_000

interface AprRange {
  max: number
  min: number
}

/**
 * One listed book.
 *
 * A component per asset rather than a loop over values, because everything on
 * the row is per-instance: its own quote engine call, its own vault stats, its
 * own capacity. The list used to hold one asset's figures and render them under
 * a hardcoded XLM label, which is a shape that cannot show two.
 */
function AssetBook({ asset, tab }: { asset: UnderlyingAsset; tab: Tab }) {
  const { stats } = useVaultStats(30_000, asset.symbol)
  const isCalls = tab === 'calls'
  const side = isCalls ? 'call' : 'put'

  const [apr, setApr] = useState<AprRange | undefined>()
  // Whether the quote engine has answered yet. Without it, an APR that is still
  // on its way and one the engine could not produce render the same way, and
  // the placeholder never resolves into anything.
  const [answered, setAnswered] = useState(false)

  useEffect(() => {
    let cancelled = false
    setApr(undefined)
    setAnswered(false)

    // Quote by expiry, so the range advertised here is priced against the same
    // tenor AND the same pool utilization the earn screen and the co-signature
    // use. Asking by `days` alone quoted an empty pool, which overstated the
    // headline as the vault filled up.
    //
    // APR rises with tenor and with proximity to spot, so the full offered
    // range spans two corners:
    //   MAX = longest expiry, nearest strike   (highest yield on offer)
    //   MIN = shortest expiry, deepest OTM     (lowest/safest yield on offer)
    const dates = upcomingExpiryDates()
    const shortExpiry = dates[0].toISOString()
    const longExpiry = dates[dates.length - 1].toISOString()

    const ladder = async (expiry: string): Promise<number[] | undefined> => {
      try {
        // The headline range is a summary, not the money path — it is worth
        // less than a placeholder that sits there. An upstream the engine
        // cannot reach takes about twelve seconds to give up, so waiting for
        // that is waiting to be told nothing.
        const signal = AbortSignal.timeout(QUOTE_DEADLINE_MS)
        const aprs = (await fetchLadder(side, expiry, asset.symbol, signal)).strikes.map(
          (s) => s.apr,
        )
        return aprs.length > 0 ? aprs : undefined
      } catch {
        return undefined
      }
    }

    Promise.all([ladder(longExpiry), ladder(shortExpiry)]).then(([longL, shortL]) => {
      if (cancelled) return
      setApr(longL && shortL ? { max: Math.max(...longL), min: Math.min(...shortL) } : undefined)
      setAnswered(true)
    })

    return () => {
      cancelled = true
    }
  }, [asset.symbol, side])

  // Only block the entry point when every open expiry is full.
  const buckets = stats?.buckets ?? []
  const full =
    buckets.length > 0 && buckets.every((b) => (isCalls ? b.callFull : b.putFull))

  const capacity = isCalls ? stats?.call : stats?.put
  const segments = buckets.map((b) =>
    isCalls
      ? { label: b.label, utilized: b.callXlm, cap: b.callCapXlm, full: b.callFull }
      : { label: b.label, utilized: b.putUsd, cap: b.putCapUsd, full: b.putFull },
  )

  return (
    <div className="space-y-2">
      <AssetRow
        symbol={asset.symbol}
        name={asset.name}
        logo={asset.logo}
        type={isCalls ? 'Covered Call' : 'Cash Secured Put'}
        maxAPR={apr?.max}
        minAPR={apr?.min}
        quoted={answered}
        href={`/earn/${asset.slug}${isCalls ? '' : '?type=put'}`}
        disabled={full}
        disabledReason="Vault full"
      />

      {/* Capacity belongs to the book, not to the page: two instances have two
          independent caps, and one bar above a list of them describes neither. */}
      {capacity && (
        <EpochCapProgress
          utilized={capacity.utilized}
          cap={capacity.cap}
          unit={isCalls ? asset.symbol : 'USD'}
          decimals={isCalls ? asset.displayDecimals : 0}
          segments={segments}
        />
      )}

      {/* The engine answered and had nothing to offer. Say so once, under the
          row, rather than leaving two columns of dashes to be read as zero
          yield — and keep the row itself navigable, because the strike screen
          reports the reason in full. */}
      {answered && !apr && (
        <div className="notice notice-quiet">
          Live pricing is unavailable right now, so the offered range cannot be
          shown. Open the asset to see what the quote engine reports.
        </div>
      )}
    </div>
  )
}

export function AssetList({ tab, onTabChange }: AssetListProps) {
  // Whatever the registry will actually quote. A declared-but-gated asset is
  // not listed at all: a row that cannot be opened is worse than no row.
  const books = enabledUnderlyings()

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

      <div className="space-y-6">
        <div className="hidden md:grid grid-cols-12 px-5 label">
          <div className="col-span-4">Asset</div>
          <div className="col-span-3">Type</div>
          <div className="col-span-2">Max APR</div>
          <div className="col-span-1">Min APR</div>
          <div className="col-span-2 text-right">Action</div>
        </div>

        {books.map((asset) => (
          <AssetBook key={asset.symbol} asset={asset} tab={tab} />
        ))}

        {books.length === 0 && (
          <div className="notice notice-quiet">
            No underlying is configured to quote right now.
          </div>
        )}
      </div>
    </div>
  )
}
