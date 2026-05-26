import { getPool, ensureSchema } from '@/lib/db'
import {
  getBreakerState,
  setBreaker,
  type BreakerState,
} from '@/lib/circuit-breaker'
import { computeVolRatio, fetchCloses } from './checks'

/**
 * Automatic circuit-breaker triggers (P1-8 step 2). Evaluates the halt
 * conditions called out in the SCF risk review — volatility spike, oracle
 * stress, and a per-epoch loss cap — and trips/clears the deposit breaker via
 * `setBreaker(..., 'auto')`. Wired into the monitor cron.
 *
 * Safety rule: this only ever touches breaker rows it owns. A breaker tripped
 * manually by an admin (`source = 'manual'`) is never auto-cleared, even once
 * conditions look normal again — a human has to release it.
 */

// Short-window vol this many times the 24h baseline → halt (vs. the lower
// MONITOR_VOL_SPIKE_MULT which only warns).
const VOL_HALT_MULT = Number(process.env.MONITOR_VOL_HALT_MULT ?? 3)
// A single recent 1-minute move beyond this percent is treated as oracle
// stress (feed dislocation / flash move) and halts deposits.
const ORACLE_JUMP_PCT = Number(process.env.MONITOR_ORACLE_JUMP_PCT ?? 10)
// USD notional assigned against the vault in the current weekly epoch beyond
// which deposits are halted for the rest of the epoch.
const EPOCH_LOSS_CAP_USD = Number(process.env.MONITOR_EPOCH_LOSS_CAP_USD ?? 25_000)

export interface AutoHaltEval {
  halt: boolean
  reasons: string[]
}

/** Start (UTC) of the current weekly epoch — most recent Friday 08:00 UTC. */
export function currentEpochStart(now = new Date()): Date {
  const d = new Date(now)
  // 0=Sun … 5=Fri. Days since last Friday.
  const daysSinceFri = (d.getUTCDay() - 5 + 7) % 7
  const start = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceFri, 8, 0, 0, 0)
  )
  // If it's Friday but before 08:00 UTC, the epoch started the previous Friday.
  if (start.getTime() > d.getTime()) start.setUTCDate(start.getUTCDate() - 7)
  return start
}

async function volSpikeHalt(): Promise<string | null> {
  try {
    const ratio = await computeVolRatio()
    if (ratio !== null && ratio >= VOL_HALT_MULT) {
      return `volatility spike ${ratio.toFixed(2)}× 24h baseline (halt ≥ ${VOL_HALT_MULT}×)`
    }
    return null
  } catch {
    // Vol data unavailable is handled as its own alert elsewhere; don't halt on it.
    return null
  }
}

async function oracleStressHalt(): Promise<string | null> {
  try {
    const closes = await fetchCloses('1m', 6)
    let maxMovePct = 0
    for (let i = 1; i < closes.length; i++) {
      const movePct = Math.abs((closes[i] - closes[i - 1]) / closes[i - 1]) * 100
      if (movePct > maxMovePct) maxMovePct = movePct
    }
    if (maxMovePct >= ORACLE_JUMP_PCT) {
      return `oracle stress — ${maxMovePct.toFixed(1)}% 1m price move (halt ≥ ${ORACLE_JUMP_PCT}%)`
    }
    return null
  } catch {
    // Feed unreachable = we can't price settlements safely → halt.
    return 'oracle stress — price feed unreachable'
  }
}

/** USD notional assigned against the vault since the current epoch started. */
export async function epochAssignedNotionalUsd(): Promise<number> {
  await ensureSchema()
  const res = await getPool().query(
    `select coalesce(sum(d.amount), 0)::float8 as assigned_usd
       from transactions c
       join transactions d
         on d.type = 'deposit'
        and d.tx_hash = (c.metadata->>'depositHash')
      where c.type = 'claim'
        and (c.metadata->>'outcome') = 'assigned'
        and c.created_at >= $1`,
    [currentEpochStart().toISOString()]
  )
  return Number(res.rows[0]?.assigned_usd ?? 0)
}

async function epochLossHalt(): Promise<string | null> {
  try {
    const assigned = await epochAssignedNotionalUsd()
    if (assigned >= EPOCH_LOSS_CAP_USD) {
      return `per-epoch loss cap — $${assigned.toFixed(0)} assigned this epoch (cap $${EPOCH_LOSS_CAP_USD})`
    }
    return null
  } catch {
    // Can't read assignments → don't auto-halt on this signal alone.
    return null
  }
}

/** Evaluate every auto-halt condition. Never throws. */
export async function evaluateAutoHalt(): Promise<AutoHaltEval> {
  const reasons = (
    await Promise.all([volSpikeHalt(), oracleStressHalt(), epochLossHalt()])
  ).filter((r): r is string => r !== null)
  return { halt: reasons.length > 0, reasons }
}

export interface AutoBreakerResult {
  changed: boolean
  state: BreakerState
  evaluation: AutoHaltEval
}

/**
 * Trip or clear the breaker based on the auto conditions. Trips when a halt
 * condition appears and the breaker is open; clears only an *auto* trip once
 * conditions are normal. Leaves manual trips untouched.
 */
export async function applyAutoBreaker(): Promise<AutoBreakerResult> {
  const evaluation = await evaluateAutoHalt()
  const state = await getBreakerState()

  if (evaluation.halt && !state.tripped) {
    const next = await setBreaker({
      tripped: true,
      reason: `auto-halt: ${evaluation.reasons.join('; ')}`,
      source: 'auto',
      updatedBy: 'monitor',
    })
    return { changed: true, state: next, evaluation }
  }

  if (!evaluation.halt && state.tripped && state.source === 'auto') {
    const next = await setBreaker({
      tripped: false,
      reason: 'auto-cleared: risk conditions back to normal',
      source: 'auto',
      updatedBy: 'monitor',
    })
    return { changed: true, state: next, evaluation }
  }

  return { changed: false, state, evaluation }
}
