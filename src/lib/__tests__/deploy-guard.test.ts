import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { ROLE_CONTROLS, deskFromManifest, releaseRefusals } from '../../../scripts/lib/deploy-guard.mjs'

// The public-network deploy guard.
// ================================
// Every test starts from a release that would deploy cleanly and moves one
// thing: the wasm, a config field, a limit, the quoter set, or the control on
// one of the three accounts the constructor hands power to. The clean case has
// to be clean or none of the refusals mean anything.

const ADMIN = 'GADMINXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
const GUARDIAN = 'GGUARDIANXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
const TREASURY = 'GTREASURYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
const QUOTER = 'GQUOTERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
const HASH = 'ab'.repeat(32)

interface Account {
  thresholds: { low: number; med: number; high: number }
  signers: { key: string; weight: number }[]
}

const signers = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ key: `GSIGNER${i}`.padEnd(56, 'X'), weight: 1 }))

const multisig = (med: number, high: number, count = 3): Account => ({
  thresholds: { low: 1, med, high },
  signers: signers(count),
})

function release() {
  const manifest = {
    network: 'public',
    wasmHash: HASH,
    books: {
      BTC: {
        vault: 'CBTCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        config: {
          admin: ADMIN,
          cash: 'CUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          feed: 'BTC',
          guardian: GUARDIAN,
          oracle: 'CORACLEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          token: 'CBTCTOKENXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          treasury: TREASURY,
        },
        limits: {
          max_expiry_call: '50000000',
          max_expiry_put: '1500000000000',
          max_open_call: '100000000',
          max_open_put: '3000000000000',
          max_position_call: '500000',
          max_position_put: '15000000000',
          max_premium_bps: 2000,
        },
        quoters: [QUOTER],
      },
    },
    accounts: {
      [ADMIN]: { roles: ['admin'], ...multisig(2, 2) },
      [GUARDIAN]: { roles: ['guardian'], ...multisig(1, 2) },
      [TREASURY]: { roles: ['treasury'], ...multisig(2, 2) },
      [QUOTER]: { roles: ['quoter'], ...multisig(1, 2) },
    } as Record<string, Account & { roles: string[] }>,
  }
  const book = manifest.books.BTC
  return {
    manifest,
    network: 'public',
    symbol: 'BTC',
    wasmHash: HASH as string | null,
    desk: { ...book.config, quoters: [QUOTER] } as Record<string, any>,
    limits: { ...book.limits } as Record<string, string | number>,
    accounts: {
      [ADMIN]: multisig(2, 2),
      [GUARDIAN]: multisig(1, 2),
      [TREASURY]: multisig(2, 2),
    } as Record<string, Account | null>,
  }
}

const refusals = (mutate: (r: ReturnType<typeof release>) => void = () => {}) => {
  const r = release()
  mutate(r)
  return releaseRefusals(r as any)
}

describe('deskFromManifest', () => {
  it('reads the book the manifest declares, and nothing for one it does not', () => {
    const { manifest } = release()
    expect(deskFromManifest(manifest, 'BTC')).toMatchObject({ admin: ADMIN, guardian: GUARDIAN, feed: 'BTC' })
    expect(deskFromManifest(manifest, 'ETH')).toBeNull()
  })
})

describe('the public-network deploy guard', () => {
  it('passes a deploy that is the reviewed release', () => {
    expect(refusals()).toEqual([])
  })

  it('refuses when no release has been recorded for the network', () => {
    const out = refusals((r) => {
      r.manifest = null as any
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('no release manifest for the public network')
  })

  it('refuses a manifest written for another network', () => {
    expect(refusals((r) => {
      r.manifest.network = 'testnet'
    })).toContainEqual(expect.stringContaining('the manifest is for testnet, not public'))
  })

  it('refuses a book the review never saw', () => {
    const out = refusals((r) => {
      r.symbol = 'ETH'
    })
    expect(out).toEqual([expect.stringContaining('declares no ETH book')])
  })

  it('refuses a wasm that is not the reviewed hash, and a deploy with no wasm at all', () => {
    expect(refusals((r) => {
      r.wasmHash = 'cd'.repeat(32)
    })).toContainEqual(expect.stringContaining(`not the manifest's reviewed ${HASH}`))
    expect(refusals((r) => {
      r.wasmHash = null
    })).toContainEqual(expect.stringContaining('--wasm is required'))
  })

  it.each(['oracle', 'admin', 'guardian', 'treasury', 'token', 'cash', 'feed'])(
    'refuses a %s the manifest does not name',
    (field) => {
      expect(refusals((r) => {
        r.desk[field] = 'GELSEWHEREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
      })).toContainEqual(expect.stringContaining(`${field} would be GELSEWHERE`))
    },
  )

  it('refuses a v6 deploy with no guardian', () => {
    expect(refusals((r) => {
      r.desk.guardian = null
    })).toContainEqual(expect.stringContaining('guardian would be (unset)'))
  })

  it('refuses a limit a stroop away from the reviewed one', () => {
    expect(refusals((r) => {
      r.limits.max_position_call = '500001'
    })).toEqual([
      "max_position_call would be 500001, the manifest's is 500000",
    ])
  })

  it.each(['max_open_call', 'max_open_put'])('refuses a deploy that leaves %s unset', (field) => {
    expect(refusals((r) => {
      delete r.limits[field]
    })).toContainEqual(expect.stringContaining(`${field} would be (unset)`))
  })

  it('refuses an extra quoter, and does not call a reordered set drift', () => {
    const extra = 'GEXTRAQUOTERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
    expect(refusals((r) => {
      r.desk.quoters = [QUOTER, extra]
    })).toEqual([expect.stringContaining('the quoter set would be')])
    expect(refusals((r) => {
      r.manifest.books.BTC.quoters = [extra, QUOTER]
      r.manifest.accounts[extra] = { roles: ['quoter'], ...multisig(1, 2) }
      r.desk.quoters = [QUOTER, extra]
    })).toEqual([])
  })

  it('refuses a role account Horizon does not have', () => {
    expect(refusals((r) => {
      r.accounts[GUARDIAN] = null
    })).toEqual([expect.stringContaining(`guardian account ${GUARDIAN} could not be read`)])
  })

  it('refuses a role account the manifest has no record of', () => {
    expect(refusals((r) => {
      delete r.manifest.accounts[TREASURY]
    })).toEqual([expect.stringContaining(`no record of the treasury account ${TREASURY}`)])
  })

  it('refuses an account whose signers were changed after the review', () => {
    expect(refusals((r) => {
      r.accounts[ADMIN] = {
        thresholds: { low: 1, med: 2, high: 2 },
        signers: [...signers(2), { key: 'GINTRUDER'.padEnd(56, 'X'), weight: 1 }],
      }
    })).toEqual([expect.stringContaining(`admin account ${ADMIN} does not match the manifest's record`)])
  })

  it('does not call a reordered signer list a change', () => {
    expect(refusals((r) => {
      r.accounts[ADMIN] = { thresholds: { low: 1, med: 2, high: 2 }, signers: signers(3).reverse() }
    })).toEqual([])
  })

  // The manifest comparison alone would accept a release that recorded a
  // single-key admin: it matches itself. The documented control is the second
  // half of the guard.
  it('refuses a single-signer admin even when the manifest records it that way', () => {
    const single = { thresholds: { low: 1, med: 1, high: 1 }, signers: signers(1) }
    const out = refusals((r) => {
      r.manifest.accounts[ADMIN] = { roles: ['admin'], ...single }
      r.accounts[ADMIN] = single
    })
    expect(out).toEqual([
      expect.stringContaining('has 1 signer(s), and the release documents 3'),
      expect.stringContaining('med threshold of 1, below the documented 2'),
      expect.stringContaining('high threshold of 1, below the documented 2'),
    ])
  })

  it('lets the guardian be paused by any single signer but changed by two', () => {
    expect(ROLE_CONTROLS.guardian).toEqual({ minSigners: 3, minMed: 1, minHigh: 2 })
    // med 1 is the design, so only a high threshold below 2 is a refusal.
    expect(refusals((r) => {
      const weak = { thresholds: { low: 1, med: 1, high: 1 }, signers: signers(3) }
      r.manifest.accounts[GUARDIAN] = { roles: ['guardian'], ...weak }
      r.accounts[GUARDIAN] = weak
    })).toEqual([expect.stringContaining(`${GUARDIAN} has a high threshold of 1`)])
  })
})

describe('scripts/deploy-vault.mjs on the public network', () => {
  const ROOT = path.resolve(__dirname, '../../..')

  // A fully configured public-network deploy, run from a directory with no
  // release manifest in it. Everything else is there, so the only thing left
  // to stop it is the one this commit adds. The RPC and Horizon hosts do not
  // resolve: reaching either before refusing would be the bug.
  const ENV: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'test',
    NEXT_PUBLIC_STELLAR_NETWORK: 'public',
    NEXT_PUBLIC_RPC_URL: 'https://rpc.invalid',
    NEXT_PUBLIC_HORIZON_URL: 'https://horizon.invalid',
    REFLECTOR_ORACLE_ID: 'CORACLEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    NEXT_PUBLIC_BTC_CONTRACT: 'CBTCTOKENXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    VAULT_CASH_CONTRACT: 'CUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    VAULT_ADMIN: ADMIN,
    VAULT_GUARDIAN: GUARDIAN,
    VAULT_TREASURY: TREASURY,
    VAULT_QUOTERS: QUOTER,
    VAULT_ONCHAIN_MAX_POSITION_CALL_BTC: '0.05',
    VAULT_ONCHAIN_MAX_POSITION_PUT_BTC: '1500',
    VAULT_ONCHAIN_MAX_EXPIRY_CALL_BTC: '5',
    VAULT_ONCHAIN_MAX_EXPIRY_PUT_BTC: '150000',
    VAULT_ONCHAIN_MAX_OPEN_CALL_BTC: '10',
    VAULT_ONCHAIN_MAX_OPEN_PUT_BTC: '300000',
    VAULT_DEPLOY_SECRET: 'SCFJVYZ33I7V6VY6GU5YQ5PWFL6POTEM7DNE3WBOZKCZNMIVFK3Z4F2D',
  }

  function run(args: string[]) {
    const cwd = mkdtempSync(path.join(tmpdir(), 'lusty-deploy-'))
    mkdirSync(path.join(cwd, 'release'))
    writeFileSync(path.join(cwd, '.env.local'), '')
    try {
      const stdout = execFileSync(
        process.execPath,
        [path.join(ROOT, 'scripts', 'deploy-vault.mjs'), ...args],
        { cwd, env: ENV, encoding: 'utf8', stdio: 'pipe' },
      )
      return { status: 0, out: stdout }
    } catch (e) {
      const err = e as { status: number; stderr: string; stdout: string }
      return { status: err.status, out: `${err.stdout ?? ''}\n${err.stderr ?? ''}` }
    }
  }

  it('refuses a public-network deploy with no reviewed release recorded', () => {
    const r = run(['BTC', '--dry-run'])
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('no release manifest for the public network')
    expect(r.out).not.toContain('deploying')
  }, 20_000)
})
