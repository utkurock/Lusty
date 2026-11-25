import { ensureSchema, getPool } from '@/lib/db'
import type { Alert } from './notify'

/**
 * Lapsed quote reservations the chain could not resolve.
 *
 * Every signature the quoter hands out reserves its allowance until it is
 * accounted for. Once the signature lapses, the monitor's sweep reads the
 * owner's positions and settles it — opened, indexed or unused. When that read
 * fails the reservation stays pending, by design: an allowance that cannot be
 * checked is not handed back. Pending counts against the wallet's allowances
 * and the shared per-strike inventory.
 *
 * Which is right, and silent. An RPC outage turns every lapsed signature into
 * held inventory; writers start being refused for room that is not really
 * taken; and the only trace is a `kept` count in the sweep's response that no
 * one reads. So this counts what is still pending well after it lapsed —
 * longer than a few sweeps would take — and says how many, under how many
 * wallets, how much they hold and since when.
 *
 * It reads the table rather than the sweep's result, so a sweep that is not
 * running at all, or that is behind its per-run owner limit, shows here too.
 */

const LAPSE_MIN = Number(process.env.MONITOR_RESERVATION_LAPSE_MINUTES ?? 30)

export interface UnresolvedReservations {
  count: number
  owners: number
  books: string[]
  notionalUsd: number
  /** The earliest `valid_until` among them: unresolved since. */
  oldest: Date | null
}

/** The alert for the reservations still unresolved, or null when none are. Pure. */
export function lapsedReservationsAlert(
  r: UnresolvedReservations,
  lapseMin: number = LAPSE_MIN,
): Alert | null {
  if (r.count === 0) return null
  const since = r.oldest?.toISOString() ?? 'an unrecorded time'
  return {
    severity: 'warning',
    title: 'Lapsed quote reservations cannot be resolved against the chain',
    message:
      `${r.count} quote reservation(s) under ${r.owners} wallet(s) lapsed more than ${lapseMin} ` +
      `minutes ago and are still pending, the oldest since ${since}. They count against the ` +
      `allowances and the per-strike inventory until each owner's positions can be read, so ` +
      `writers on ${r.books.join(', ')} are being refused room worth $${r.notionalUsd.toFixed(0)} ` +
      'that may not be taken. Usually the RPC: the sweep keeps them pending, rightly, while it ' +
      'cannot read positions.',
    fields: [
      { label: 'pending', value: String(r.count) },
      { label: 'wallets', value: String(r.owners) },
      { label: 'notional_usd', value: r.notionalUsd.toFixed(2) },
      { label: 'since', value: since },
      { label: 'books', value: r.books.join(', ') },
    ],
  }
}

export async function checkLapsedReservations(): Promise<Alert | null> {
  try {
    await ensureSchema()
    const { rows } = await getPool().query(
      `select count(*)::int as count,
              count(distinct (address, underlying))::int as owners,
              coalesce(array_agg(distinct underlying), '{}') as books,
              coalesce(sum(notional_usd), 0)::float8 as notional_usd,
              min(valid_until) as oldest
         from quote_reservations
        where state = 'pending'
          and valid_until < now() - make_interval(mins => $1)`,
      [LAPSE_MIN],
    )
    const row = rows[0] ?? {}
    return lapsedReservationsAlert({
      count: Number(row.count ?? 0),
      owners: Number(row.owners ?? 0),
      books: [...(row.books ?? [])].sort(),
      notionalUsd: Number(row.notional_usd ?? 0),
      oldest: row.oldest ? new Date(row.oldest) : null,
    })
  } catch (e: any) {
    return {
      severity: 'critical',
      title: 'Lapsed reservation watch failed',
      message: `Could not read quote reservations: ${e?.message ?? 'unknown'}. Allowances held by signatures the chain cannot resolve would go unreported.`,
    }
  }
}
