import { getPool, ensureSchema } from './db'

/**
 * Quoting circuit breaker (P1-8): DB-backed kill-switches that, when tripped,
 * make the quote co-signature fail closed (503), and without a quoter
 * signature no position can open.
 *
 * One switch per book plus one over the whole desk. A stress condition on one
 * market halts that market's book; the desk-wide switch is for what is not
 * any one market's (the per-epoch loss cap, an admin halting everything). A
 * book is quoting only while both its own switch and the desk's are open.
 */

export type BreakerSource = 'manual' | 'auto'

/** The scope of the desk-wide switch. Every other scope is a book's symbol. */
export const ALL_BOOKS = 'all'

export interface BreakerState {
  scope: string
  tripped: boolean
  reason: string | null
  source: BreakerSource
  updatedBy: string | null
  updatedAt: string | null
}

const open = (scope: string): BreakerState => ({
  scope,
  tripped: false,
  reason: null,
  source: 'manual',
  updatedBy: null,
  updatedAt: null,
})

function toState(r: any): BreakerState {
  return {
    scope: r.scope,
    tripped: r.tripped === true,
    reason: r.reason ?? null,
    source: (r.source as BreakerSource) ?? 'manual',
    updatedBy: r.updated_by ?? null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  }
}

/** Every switch that has ever been set, the desk's first. */
export async function listBreakers(): Promise<BreakerState[]> {
  await ensureSchema()
  const res = await getPool().query(
    `select scope, tripped, reason, source, updated_by, updated_at
       from circuit_breakers
      order by scope = $1 desc, scope`,
    [ALL_BOOKS]
  )
  const states = res.rows.map(toState)
  return states.some((s) => s.scope === ALL_BOOKS) ? states : [open(ALL_BOOKS), ...states]
}

/**
 * The switch that governs quoting. With a book's symbol: the desk's switch if
 * it is tripped, else the book's own. Without: the desk's.
 *
 * Throws if the DB is unreachable — callers that gate money movement must
 * treat that as "cannot prove we're safe" and fail closed, not assume open.
 */
export async function getBreakerState(symbol?: string): Promise<BreakerState> {
  await ensureSchema()
  const scopes = symbol ? [ALL_BOOKS, symbol.toUpperCase()] : [ALL_BOOKS]
  const res = await getPool().query(
    `select scope, tripped, reason, source, updated_by, updated_at
       from circuit_breakers where scope = any($1)`,
    [scopes]
  )
  const states = scopes.map((s) => {
    const row = res.rows.find((r: any) => r.scope === s)
    return row ? toState(row) : open(s)
  })
  return states.find((s) => s.tripped) ?? states[states.length - 1]
}

/** One switch exactly as stored, without the desk's folded in. */
export async function getScopeState(scope: string): Promise<BreakerState> {
  await ensureSchema()
  const res = await getPool().query(
    `select scope, tripped, reason, source, updated_by, updated_at
       from circuit_breakers where scope = $1`,
    [scope]
  )
  return res.rows[0] ? toState(res.rows[0]) : open(scope)
}

/**
 * Set one switch. `tripped=true` halts quoting in that scope; `false` resumes
 * it. `updatedBy` is the admin address (manual) or a trigger name (auto).
 */
export async function setBreaker(params: {
  scope?: string
  tripped: boolean
  reason?: string | null
  source?: BreakerSource
  updatedBy?: string | null
}): Promise<BreakerState> {
  const scope = (params.scope ?? ALL_BOOKS).toLowerCase() === ALL_BOOKS
    ? ALL_BOOKS
    : params.scope!.toUpperCase()
  await ensureSchema()
  await getPool().query(
    `insert into circuit_breakers (scope, tripped, reason, source, updated_by, updated_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (scope) do update
        set tripped = excluded.tripped,
            reason = excluded.reason,
            source = excluded.source,
            updated_by = excluded.updated_by,
            updated_at = now()`,
    [scope, params.tripped, params.reason ?? null, params.source ?? 'manual', params.updatedBy ?? null]
  )
  return getScopeState(scope)
}
