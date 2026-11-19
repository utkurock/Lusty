import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  compareRelease,
  describeDrift,
  observeRelease,
  type Manifest,
} from '../drift.mjs'
import { XLM, BTC } from '../assets'
import { toTokenUnits } from '../vault-contract'

// The release manifest against a fake network.
// ============================================
// Every test starts from a network that matches release/testnet.json exactly
// (the clean case must be clean, or every other assertion is noise) and moves
// one thing on it, the way drift arrives: an instance upgraded, a limit set, a
// quoter added, a signer or a threshold changed on a role account.

const manifest: Manifest = JSON.parse(
  readFileSync(join(__dirname, '../../../release/testnet.json'), 'utf8'),
)

/** A network that runs exactly the manifest, as mutable plain data. */
function chainFromManifest() {
  const m = structuredClone(manifest)
  return {
    wasm: Object.fromEntries(Object.values(m.books).map((b) => [b.vault, m.wasmHash])),
    // The RPC hands back i128 as bigint; the manifest stores decimal strings.
    contracts: Object.fromEntries(
      Object.values(m.books).map((b) => [
        b.vault,
        {
          config: { ...b.config },
          limits: Object.fromEntries(
            Object.entries(b.limits).map(([k, v]) => [k, typeof v === 'string' ? BigInt(v) : v]),
          ) as Record<string, unknown>,
          quoters: [...b.quoters],
        },
      ]),
    ),
    accounts: Object.fromEntries(
      Object.entries(m.accounts).map(([a, r]) => [a, { thresholds: { ...r.thresholds }, signers: [...r.signers] }]),
    ) as Record<string, { thresholds: { low: number; med: number; high: number }; signers: { key: string; weight: number }[] }>,
  }
}

type Chain = ReturnType<typeof chainFromManifest>

function readers(chain: Chain) {
  return {
    readWasmHash: async (id: string) => chain.wasm[id],
    readContract: async (id: string, method: string) =>
      (chain.contracts[id] as Record<string, unknown>)[method],
    loadAccount: async (address: string) => {
      const acc = chain.accounts[address]
      if (!acc) throw Object.assign(new Error('Not Found'), { response: { status: 404 } })
      return acc
    },
  }
}

async function driftOf(chain: Chain) {
  return compareRelease(manifest, await observeRelease(manifest, readers(chain)))
}

const XLM_VAULT = manifest.books.XLM.vault
const ADMIN = manifest.books.XLM.config.admin as string

describe('the testnet manifest itself', () => {
  it('names one 32-byte wasm hash and a record for every account a book names', () => {
    expect(manifest.network).toBe('testnet')
    expect(manifest.wasmHash).toMatch(/^[0-9a-f]{64}$/)
    for (const book of Object.values(manifest.books)) {
      const named = [book.config.admin, book.config.treasury, ...book.quoters]
      for (const a of named) expect(manifest.accounts[a as string]).toBeDefined()
    }
  })

  it('records the limits the asset declarations say each instance enforces', () => {
    // Two records of the same numbers, kept in two places for two readers: the
    // declaration for the money path, the manifest for the release. A change
    // to one without the other fails here, in review, not on chain.
    for (const asset of [XLM, BTC]) {
      const d = asset.onchainLimits
      expect(manifest.books[asset.symbol].limits).toEqual({
        max_position_call: toTokenUnits(d.maxPositionCall).toString(),
        max_position_put: toTokenUnits(d.maxPositionPut).toString(),
        max_expiry_call: toTokenUnits(d.maxExpiryCall).toString(),
        max_expiry_put: toTokenUnits(d.maxExpiryPut).toString(),
        max_premium_bps: d.maxPremiumBps,
      })
    }
  })

  it('records the admin as the 2-of-3 multisig SECURITY.md describes', () => {
    const admin = manifest.accounts[ADMIN]
    expect(admin.roles).toEqual(['admin'])
    expect(admin.signers).toHaveLength(3)
    expect(admin.thresholds).toEqual({ low: 2, med: 2, high: 2 })
  })
})

describe('compareRelease against the network', () => {
  it('finds nothing on a network that runs the manifest', async () => {
    expect(await driftOf(chainFromManifest())).toEqual([])
  })

  it('catches an instance running a wasm nobody reviewed', async () => {
    const chain = chainFromManifest()
    chain.wasm[XLM_VAULT] = 'ab'.repeat(32)
    const drift = await driftOf(chain)
    expect(drift).toHaveLength(1)
    expect(drift[0].path).toBe('wasmHash')
    expect(String(drift[0].observed)).toContain('abab')
  })

  it('catches a limit set on chain, to the stroop', async () => {
    const chain = chainFromManifest()
    ;(chain.contracts[XLM_VAULT].limits as any).max_position_call += 1n
    const drift = await driftOf(chain)
    expect(drift).toEqual([
      { path: 'books.XLM.limits.max_position_call', expected: '100000000000', observed: '100000000001' },
    ])
  })

  it('catches a v6 instance where the manifest records a v5 one', async () => {
    const chain = chainFromManifest()
    const guardian = 'GDGUARDIANXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
    ;(chain.contracts[XLM_VAULT].config as any).guardian = guardian
    ;(chain.contracts[XLM_VAULT].limits as any).max_open_call = 1n
    chain.accounts[guardian] = { thresholds: { low: 1, med: 1, high: 1 }, signers: [] }
    const paths = (await driftOf(chain)).map((d) => d.path)
    expect(paths).toContain('books.XLM.config.guardian')
    expect(paths).toContain('books.XLM.limits.max_open_call')
    // The guardian is a role account the manifest has no record of.
    expect(paths).toContain(`accounts.${guardian}`)
  })

  it('catches a quoter added on chain, and reads the new key rather than skipping it', async () => {
    const chain = chainFromManifest()
    const extra = 'GDEXTRAQUOTERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
    ;(chain.contracts[XLM_VAULT].quoters as string[]).push(extra)
    chain.accounts[extra] = { thresholds: { low: 0, med: 0, high: 0 }, signers: [{ key: extra, weight: 1 }] }
    const paths = (await driftOf(chain)).map((d) => d.path)
    expect(paths).toEqual(['books.XLM.quoters', `accounts.${extra}`])
  })

  it('does not call a reordered quoter set drift', async () => {
    const chain = chainFromManifest()
    const extra = 'GAAAQUOTERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
    const m = structuredClone(manifest)
    m.books.XLM.quoters = [extra, ...m.books.XLM.quoters]
    m.accounts[extra] = { roles: ['quoter'], thresholds: { low: 0, med: 0, high: 0 }, signers: [] }
    ;(chain.contracts[XLM_VAULT].quoters as string[]).push(extra)
    chain.accounts[extra] = { thresholds: { low: 0, med: 0, high: 0 }, signers: [] }
    expect(compareRelease(m, await observeRelease(m, readers(chain)))).toEqual([])
  })

  it('catches the admin multisig lowered to one signature', async () => {
    const chain = chainFromManifest()
    chain.accounts[ADMIN].thresholds = { low: 1, med: 1, high: 1 }
    const drift = await driftOf(chain)
    expect(drift.map((d) => d.path)).toEqual(
      ['low', 'med', 'high'].map((t) => `accounts.${ADMIN}.thresholds.${t}`),
    )
    expect(describeDrift(drift[2])).toBe(`accounts.${ADMIN}.thresholds.high: manifest 2, network 1`)
  })

  it('catches a signer added to the treasury', async () => {
    const chain = chainFromManifest()
    const treasury = manifest.books.XLM.config.treasury as string
    chain.accounts[treasury].signers = [
      ...chain.accounts[treasury].signers,
      { key: 'GDINTRUDERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', weight: 1 },
    ]
    expect((await driftOf(chain)).map((d) => d.path)).toEqual([`accounts.${treasury}.signers`])
  })

  it('reports a role account that no longer exists as missing', async () => {
    const chain = chainFromManifest()
    delete chain.accounts[ADMIN]
    const drift = await driftOf(chain)
    expect(drift).toHaveLength(1)
    expect(drift[0]).toMatchObject({ path: `accounts.${ADMIN}`, observed: undefined })
    expect(describeDrift(drift[0])).toContain('network (absent)')
  })

  it('throws on an account read that failed for any other reason, rather than calling it missing', async () => {
    const chain = chainFromManifest()
    const r = readers(chain)
    r.loadAccount = async () => {
      throw Object.assign(new Error('503'), { response: { status: 503 } })
    }
    await expect(observeRelease(manifest, r)).rejects.toThrow('503')
  })
})
