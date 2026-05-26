import { getPool, ensureSchema } from './db'

/**
 * Deposit circuit breaker (P1-8). A single-row DB-backed kill-switch that,
 * when tripped, makes the deposit endpoint fail closed (503). This first step
 * is the manual override + the gating mechanism; automatic triggers (vol
 * spike, oracle stress, per-epoch loss cap) build on `tripBreaker(... 'auto')`
 * in a later step.
 */

export type BreakerSource = 'manual' | 'auto'

export interface BreakerState {
  tripped: boolean
  reason: string | null
  source: BreakerSource
  updatedBy: string | null
  updatedAt: string | null
}

const OPEN: BreakerState = {
  tripped: false,
  reason: null,
  source: 'manual',
  updatedBy: null,
  updatedAt: null,
}

/**
 * Current breaker state. Throws if the DB is unreachable — callers that gate
 * money movement (the deposit handler) must treat that as "cannot prove we're
 * safe" and fail closed, not assume the breaker is open.
 */
export async function getBreakerState(): Promise<BreakerState> {
  await ensureSchema()
  const res = await getPool().query(
    `select tripped, reason, source, updated_by, updated_at
     from circuit_breaker where id = 1`
  )
  if (res.rows.length === 0) return OPEN
  const r = res.rows[0]
  return {
    tripped: r.tripped === true,
    reason: r.reason ?? null,
    source: (r.source as BreakerSource) ?? 'manual',
    updatedBy: r.updated_by ?? null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  }
}

/**
 * Set the breaker. `tripped=true` halts new deposits; `false` resumes them.
 * `updatedBy` is the admin address (manual) or a trigger name (auto).
 */
export async function setBreaker(params: {
  tripped: boolean
  reason?: string | null
  source?: BreakerSource
  updatedBy?: string | null
}): Promise<BreakerState> {
  await ensureSchema()
  await getPool().query(
    `update circuit_breaker
        set tripped = $1,
            reason = $2,
            source = $3,
            updated_by = $4,
            updated_at = now()
      where id = 1`,
    [
      params.tripped,
      params.reason ?? null,
      params.source ?? 'manual',
      params.updatedBy ?? null,
    ]
  )
  return getBreakerState()
}
