import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Manifest } from '../drift.mjs'

// Role-account signers and thresholds, as they change.
// ====================================================
// The drift check sees the state; this sees the change, including one made and
// undone between two reads. Each account follows its own Horizon cursor: the
// first read reports the last day and takes the newest token, later reads go
// forward from it, and a change is reported once.

const cursors = new Map<string, string>()
let dbError: Error | null = null

vi.mock('@/lib/db', () => ({
  ensureSchema: async () => {},
  getPool: () => ({
    query: async (sql: string, params: any[]) => {
      if (dbError) throw dbError
      if (sql.includes('select cursor')) {
        const c = cursors.get(params[0])
        return { rows: c ? [{ cursor: c }] : [] }
      }
      cursors.set(params[0], params[1])
      return { rows: [] }
    },
  }),
}))

const { checkRoleAccounts, roleAccountAlert } = await import('../monitor/role-accounts')

const manifest: Manifest = JSON.parse(readFileSync(join(__dirname, '../../../release/testnet.json'), 'utf8'))
const ADMIN = manifest.books.XLM.config.admin as string
const loadManifest = async () => manifest
const NOW = Date.parse('2026-11-27T12:00:00Z')

/** Effects per account, oldest first, with paging tokens in order. */
let effects: Record<string, any[]> = {}
const reads: { account: string; cursor?: string; order: string }[] = []
const read = async (account: string, { cursor, order, limit }: { cursor?: string; order: 'asc' | 'desc'; limit: number }) => {
  reads.push({ account, cursor, order })
  const all = effects[account] ?? []
  if (order === 'desc') return [...all].reverse().slice(0, limit)
  return all.filter((e) => !cursor || e.paging_token > cursor).slice(0, limit)
}
const effect = (token: string, at: string, type: string, extra: any = {}) => ({
  account: ADMIN, type, created_at: at, paging_token: token, ...extra,
})

beforeEach(() => {
  cursors.clear()
  effects = {}
  reads.length = 0
  dbError = null
})

describe('checkRoleAccounts', () => {
  it('reads every role account the manifest names', async () => {
    await checkRoleAccounts({ loadManifest, read, now: NOW })
    expect(new Set(reads.map((r) => r.account))).toEqual(new Set(Object.keys(manifest.accounts)))
  })

  it("reports the last day's changes on a first read and nothing older, then takes the newest token", async () => {
    effects[ADMIN] = [
      effect('0001', '2026-11-20T00:00:00Z', 'signer_created', { public_key: 'GOLDSIGNERXXXX', weight: 1 }),
      effect('0002', '2026-11-27T11:00:00Z', 'account_thresholds_updated', { low_threshold: 1, med_threshold: 1, high_threshold: 1 }),
      effect('0003', '2026-11-27T11:01:00Z', 'account_debited'),
    ]
    const alert = await checkRoleAccounts({ loadManifest, read, now: NOW })
    expect(alert?.severity).toBe('critical')
    expect(alert?.message).toContain('thresholds set to low 1 / med 1 / high 1')
    expect(alert?.message).toContain('admin')
    expect(alert?.message).not.toContain('GOLDSI')
    expect(cursors.get(`role-account:${ADMIN}`)).toBe('0003')
  })

  it('catches a signer added and removed between two runs, and reports each once', async () => {
    cursors.set(`role-account:${ADMIN}`, '0001')
    effects[ADMIN] = [
      effect('0001', '2026-11-27T10:00:00Z', 'account_credited'),
      effect('0002', '2026-11-27T11:00:00Z', 'signer_created', { public_key: 'GINTRUDERXXXXXXXX', weight: 2 }),
      effect('0003', '2026-11-27T11:02:00Z', 'signer_removed', { public_key: 'GINTRUDERXXXXXXXX', weight: 0 }),
    ]
    const alert = await checkRoleAccounts({ loadManifest, read, now: NOW })
    expect(alert?.message).toContain('added with weight 2')
    expect(alert?.message).toContain('removed')
    expect(await checkRoleAccounts({ loadManifest, read, now: NOW })).toBeNull()
  })

  it('skips an account Horizon does not know; the drift check reports it', async () => {
    const missing = async (account: string, opts: any) => {
      if (account === ADMIN) throw Object.assign(new Error('Not Found'), { response: { status: 404 } })
      return read(account, opts)
    }
    expect(await checkRoleAccounts({ loadManifest, read: missing, now: NOW })).toBeNull()
  })

  it('is critical when Horizon cannot be read, rather than quiet', async () => {
    const down = async () => {
      throw new Error('Horizon 503')
    }
    const alert = await checkRoleAccounts({ loadManifest, read: down, now: NOW })
    expect(alert?.severity).toBe('critical')
    expect(alert?.message).toContain('Horizon 503')
  })

  it('leaves a missing manifest to the drift check', async () => {
    const none = async () => {
      throw new Error('ENOENT')
    }
    expect(await checkRoleAccounts({ loadManifest: none, read, now: NOW })).toBeNull()
  })
})

describe('roleAccountAlert', () => {
  it('is null for no changes', () => {
    expect(roleAccountAlert([], manifest)).toBeNull()
  })
})
