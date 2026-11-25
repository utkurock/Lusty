import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Manifest } from '../drift.mjs'
import { checkReleaseDrift, releaseDriftAlert } from '../monitor/release-drift'

// The drift check on the monitor's timer.
// =======================================
// The comparison itself is tested in release-drift.test.ts. Here: that the
// monitor reads the deployment's own manifest, says nothing when the network
// matches it, and is critical about everything else — a difference, a manifest
// it cannot read or one for another network, a network it cannot reach.

const manifest: Manifest = JSON.parse(
  readFileSync(join(__dirname, '../../../release/testnet.json'), 'utf8'),
)
const XLM_VAULT = manifest.books.XLM.vault
const ADMIN = manifest.books.XLM.config.admin as string

/** Readers for a network that runs `m` exactly, with `edit` applied. */
function readersFor(edit: (chain: { wasm: Record<string, string>; accounts: Record<string, any> }) => void = () => {}) {
  const m = structuredClone(manifest)
  const chain = {
    wasm: Object.fromEntries(Object.values(m.books).map((b) => [b.vault, m.wasmHash])),
    accounts: Object.fromEntries(
      Object.entries(m.accounts).map(([a, r]) => [a, { thresholds: { ...r.thresholds }, signers: [...r.signers] }]),
    ),
  }
  edit(chain)
  const byVault = Object.fromEntries(Object.values(m.books).map((b) => [b.vault, b]))
  return () => ({
    readWasmHash: async (id: string) => chain.wasm[id],
    readContract: async (id: string, method: string) => {
      const b = byVault[id]
      if (method === 'quoters') return b.quoters
      const v = method === 'config' ? b.config : b.limits
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' && /^\d+$/.test(x) ? BigInt(x) : x]))
    },
    loadAccount: async (address: string) => {
      const acc = chain.accounts[address]
      if (!acc) throw Object.assign(new Error('Not Found'), { response: { status: 404 } })
      return acc
    },
  })
}

const loadManifest = async () => structuredClone(manifest)

describe('checkReleaseDrift', () => {
  it('is quiet when the network runs the manifest', async () => {
    expect(await checkReleaseDrift({ loadManifest, readers: readersFor() })).toBeNull()
  })

  it('is critical about a lowered admin threshold, and names where', async () => {
    const alert = await checkReleaseDrift({
      loadManifest,
      readers: readersFor((c) => {
        c.accounts[ADMIN].thresholds = { low: 1, med: 1, high: 1 }
      }),
    })
    expect(alert?.severity).toBe('critical')
    expect(alert?.message).toContain(`accounts.${ADMIN}.thresholds`)
  })

  it('is critical about an instance running a wasm nobody reviewed', async () => {
    const alert = await checkReleaseDrift({
      loadManifest,
      readers: readersFor((c) => {
        c.wasm[XLM_VAULT] = 'ab'.repeat(32)
      }),
    })
    expect(alert?.severity).toBe('critical')
    expect(alert?.fields?.some((f) => f.label === 'wasmHash')).toBe(true)
  })

  it('is critical when there is no manifest to compare against', async () => {
    const alert = await checkReleaseDrift({
      loadManifest: async () => {
        throw new Error('ENOENT: no such file')
      },
      readers: readersFor(),
    })
    expect(alert?.severity).toBe('critical')
    expect(alert?.title).toMatch(/No release manifest/)
  })

  it('is critical when the manifest is for another network', async () => {
    const alert = await checkReleaseDrift({
      loadManifest: async () => ({ ...structuredClone(manifest), network: 'public' }),
      readers: readersFor(),
    })
    expect(alert?.title).toMatch(/another network/)
  })

  it('is critical when the network cannot be read, rather than quiet', async () => {
    const alert = await checkReleaseDrift({
      loadManifest,
      readers: () => ({
        ...readersFor()(),
        readWasmHash: async () => {
          throw new Error('RPC 503')
        },
      }),
    })
    expect(alert?.severity).toBe('critical')
    expect(alert?.message).toContain('RPC 503')
  })

  it('reads the deployment manifest from release/<network>.json by default', async () => {
    // No loadManifest: the real file. A network that matches it is quiet.
    expect(await checkReleaseDrift({ readers: readersFor() })).toBeNull()
  })
})

describe('releaseDriftAlert', () => {
  it('is null for no drift', () => {
    expect(releaseDriftAlert([], manifest)).toBeNull()
  })

  it('caps the field list but counts every difference', () => {
    const drift = Array.from({ length: 14 }, (_, i) => ({ path: `p${i}`, expected: 1, observed: 2 }))
    const alert = releaseDriftAlert(drift, manifest)!
    expect(alert.fields?.find((f) => f.label === 'differences')?.value).toBe('14')
    expect(alert.fields?.filter((f) => f.label.startsWith('p'))).toHaveLength(10)
  })
})
