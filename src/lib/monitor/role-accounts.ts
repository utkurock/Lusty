import { Horizon } from '@stellar/stellar-sdk'
import { ensureSchema, getPool } from '@/lib/db'
import { HORIZON_URL, explorerAccountUrl } from '@/lib/stellar'
import type { Manifest } from '@/lib/drift.mjs'
import { readManifest } from './release-drift'
import type { Alert } from './notify'

/**
 * Every change to a role account's signers or thresholds, as it happens.
 *
 * The drift check compares each role account with the release manifest, which
 * catches a change that stays. It cannot see one made and undone between two
 * reads: add a signer, use it, remove it. The admin, guardian, treasury and
 * quoter accounts control the vault, and a signer added to any of them for
 * five minutes is the thing to know about. Horizon keeps an effect for every
 * signer and threshold change, so this reads them forward from a cursor per
 * account, the way the limits watch reads contract events.
 *
 * The accounts are the manifest's: the reviewed record of who holds which role.
 * When the manifest cannot be read the drift check already pages about it, so
 * this one stays quiet rather than paging twice for one cause.
 *
 * Every change is critical. These accounts change by a commit to the manifest
 * and a multisig transaction everyone signing it knows about; anything else is
 * a key in the wrong hands.
 */

const WATCHED = new Set([
  'signer_created',
  'signer_removed',
  'signer_updated',
  'account_thresholds_updated',
  'account_removed',
])
// First read of an account: report what changed in the last day, then follow.
const LOOKBACK_MS = 24 * 60 * 60_000
const PAGE = 200
const MAX_PAGES = 3

export interface RoleEffect {
  account: string
  type: string
  created_at: string
  paging_token: string
  public_key?: string
  weight?: number
  low_threshold?: number
  med_threshold?: number
  high_threshold?: number
}

export type EffectsReader = (
  account: string,
  opts: { cursor?: string; order: 'asc' | 'desc'; limit: number },
) => Promise<RoleEffect[]>

const shortKey = (k: string) => `${k.slice(0, 6)}…${k.slice(-4)}`

function describe(e: RoleEffect): string {
  switch (e.type) {
    case 'signer_created':
      return `signer ${shortKey(e.public_key ?? '?')} added with weight ${e.weight}`
    case 'signer_removed':
      return `signer ${shortKey(e.public_key ?? '?')} removed`
    case 'signer_updated':
      return `signer ${shortKey(e.public_key ?? '?')} weight set to ${e.weight}`
    case 'account_thresholds_updated':
      return `thresholds set to low ${e.low_threshold} / med ${e.med_threshold} / high ${e.high_threshold}`
    case 'account_removed':
      return 'account merged away'
    default:
      return e.type
  }
}

/** The alert for a batch of role-account changes, or null when there were none. Pure. */
export function roleAccountAlert(effects: RoleEffect[], manifest: Manifest): Alert | null {
  if (effects.length === 0) return null
  const lines = effects.map((e) => {
    const roles = manifest.accounts[e.account]?.roles?.join('+') || 'role account'
    return `${roles} ${shortKey(e.account)} at ${e.created_at}: ${describe(e)}`
  })
  const accounts = [...new Set(effects.map((e) => e.account))]
  return {
    severity: 'critical',
    title: 'Role account signers or thresholds changed',
    message:
      `${effects.length} change(s) to the signers or thresholds of ${accounts.length} role account(s): ` +
      `${lines.join('. ')}. These accounts control the vault; a change that is not in a commit to ` +
      `release/${manifest.network}.json was made by someone holding enough of its keys. ` +
      `Read each account's operations: ${accounts.map(explorerAccountUrl).join(' ')}`,
    fields: effects.slice(0, 10).map((e) => ({ label: shortKey(e.account), value: `${e.created_at} ${describe(e)}` })),
  }
}

function horizonReader(): EffectsReader {
  const server = new Horizon.Server(HORIZON_URL)
  return async (account, { cursor, order, limit }) => {
    let call = server.effects().forAccount(account).order(order).limit(limit)
    if (cursor) call = call.cursor(cursor)
    const page = await call.call()
    return page.records as unknown as RoleEffect[]
  }
}

const cursorName = (account: string) => `role-account:${account}`

/** One account's watched effects since its cursor, and the cursor to store. */
async function readAccount(
  account: string,
  cursor: string | undefined,
  read: EffectsReader,
  now: number,
): Promise<{ effects: RoleEffect[]; cursor?: string }> {
  if (!cursor) {
    const recent = await read(account, { order: 'desc', limit: PAGE })
    const since = now - LOOKBACK_MS
    return {
      effects: recent.filter((e) => WATCHED.has(e.type) && Date.parse(e.created_at) >= since).reverse(),
      cursor: recent[0]?.paging_token,
    }
  }
  const effects: RoleEffect[] = []
  let at = cursor
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await read(account, { cursor: at, order: 'asc', limit: PAGE })
    effects.push(...page.filter((e) => WATCHED.has(e.type)))
    if (page.length === 0) break
    at = page[page.length - 1].paging_token
    if (page.length < PAGE) break
  }
  return { effects, cursor: at }
}

export async function checkRoleAccounts(
  deps: { loadManifest?: () => Promise<Manifest>; read?: EffectsReader; now?: number } = {},
): Promise<Alert | null> {
  let manifest: Manifest
  try {
    manifest = await (deps.loadManifest ?? readManifest)()
  } catch {
    // The drift check pages for a missing manifest.
    return null
  }
  const read = deps.read ?? horizonReader()
  const now = deps.now ?? Date.now()
  try {
    await ensureSchema()
    const pool = getPool()
    const found: RoleEffect[] = []
    for (const account of Object.keys(manifest.accounts).sort()) {
      const { rows } = await pool.query(`select cursor from event_cursors where name = $1`, [cursorName(account)])
      const stored: string | undefined = rows[0]?.cursor ?? undefined
      let result: { effects: RoleEffect[]; cursor?: string }
      try {
        result = await readAccount(account, stored, read, now)
      } catch (e: any) {
        // An account Horizon does not know is the drift check's to report.
        if (e?.response?.status === 404) continue
        throw e
      }
      found.push(...result.effects)
      if (result.cursor && result.cursor !== stored) {
        await pool.query(
          `insert into event_cursors (name, cursor) values ($1, $2)
           on conflict (name) do update set cursor = excluded.cursor, updated_at = now()`,
          [cursorName(account), result.cursor],
        )
      }
    }
    return roleAccountAlert(found, manifest)
  } catch (e: any) {
    return {
      severity: 'critical',
      title: 'Role account watch failed',
      message: `Could not read the role accounts' signer and threshold changes from Horizon: ${e?.message ?? 'unknown'}. A signer added and removed since the last run would go unreported.`,
    }
  }
}
