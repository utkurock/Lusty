import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Account, Keypair, Transaction, rpc, xdr } from '@stellar/stellar-sdk'

// The runner key can only settle.
// ===============================
// A grant criterion in its own right: "the runner key can only settle — it
// cannot touch prices, parameters or collateral." The chain half was already
// demonstrated on testnet (16367b8, and contracts/README.md § "Permissionless
// settlement, verified on chain"): an unrelated account settled four positions
// and ended down nothing but its fees. That proves settlement pays the caller
// nothing. It does not prove this codebase never asks the runner key to do
// anything else, which is what the tests below are for.
//
// Two things are pinned here, because either alone leaves a gap:
//
//   1. WHAT THE RUNNER BUILDS. The transaction is inspected before it is
//      signed: one operation, invoking `settle` with a single argument, and no
//      authorization entries attached. `open` needs a second signature and this
//      shape structurally cannot carry one.
//   2. WHAT THE RUNNER CAN REACH. The runner's own modules are read from disk
//      and checked for any mention of the quoter key, the admin entrypoints or
//      the pool funding calls. A source check rather than a behavioural one
//      because the property is about absence: the failure being guarded
//      against is a future edit that imports the quoter into this path, and no
//      behavioural test catches a capability until something exercises it.

const RUNNER_SOURCES = {
  'lib/settlement.ts': 'src/lib/settlement.ts',
  'api/cron/settle/route.ts': 'src/app/api/cron/settle/route.ts',
} as const

function read(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), 'utf8')
}

/**
 * The same source with comments removed.
 *
 * The boundary is a property of the code, not of the prose. The route's header
 * explains what the runner cannot do and has to name `set_limits` to say so;
 * scanning the raw text would make documenting the boundary the thing that
 * breaks the test that guards it.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1')
}

describe('what the runner can reach', () => {
  // Every contract entrypoint that moves money, sets policy, or prices an
  // option. None of them belong anywhere near the settlement path.
  const FORBIDDEN_ENTRYPOINTS = [
    'set_limits',
    'add_quoter',
    'remove_quoter',
    'fund_underlying',
    "call('fund'",
    "call('open'",
    "'deposit'",
  ]

  const FORBIDDEN_SECRETS = [
    'VAULT_QUOTER_SECRET',
    'LUSD_ISSUER_SECRET',
    'LUSD_DISTRIBUTOR_SECRET',
  ]

  // Helpers that exist only to open a position. Importing any of them into the
  // runner would mean it had grown a second job.
  const FORBIDDEN_OPEN_PATH = [
    'openArgs',
    'openPosition',
    'cosignQuote',
    'describeMismatch',
    'quoteOption',
  ]

  for (const [label, path] of Object.entries(RUNNER_SOURCES)) {
    describe(label, () => {
      const source = read(path)
      const executable = code(source)

      it('names no admin or funding entrypoint', () => {
        for (const forbidden of FORBIDDEN_ENTRYPOINTS) {
          expect(executable).not.toContain(forbidden)
        }
      })

      it('reads no signing key but its own', () => {
        for (const forbidden of FORBIDDEN_SECRETS) {
          expect(executable).not.toContain(forbidden)
        }
        // What the file actually pulls out of the environment, rather than
        // what it happens to name a local constant.
        const env = [...source.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map(
          (m) => m[1]
        )
        for (const name of new Set(env)) {
          expect(['SETTLE_RUNNER_SECRET', 'CRON_SECRET']).toContain(name)
        }
      })

      it('does not reach into the quote or open path', () => {
        for (const forbidden of FORBIDDEN_OPEN_PATH) {
          expect(executable).not.toContain(forbidden)
        }
      })
    })
  }

  it('touches exactly one contract entrypoint, and it is settle', () => {
    // vault-contract.ts is a shared client that also knows how to open a
    // position, so the runner's import of it cannot be checked by absence.
    // What can be checked is which of its exports the runner actually names.
    const source = code(read(RUNNER_SOURCES['lib/settlement.ts']))
    const block = source.match(
      /import\s*\{([^}]*)\}\s*from\s*'\.\/vault-contract'/
    )
    expect(block).not.toBeNull()

    const named = block![1]
      .split(',')
      .map((s) => s.replace(/^\s*type\s+/, '').trim())
      .filter(Boolean)

    // getVaultStats and getPosition are reads. settlePosition is the only
    // thing on this list that writes, and settle is all it can invoke.
    expect(new Set(named)).toEqual(
      new Set(['getVaultStats', 'getPosition', 'settlePosition', 'OptionSide'])
    )
  })
})

describe('what the runner builds', () => {
  const VAULT = 'CBJZGTCF2PJVHX2BNFTFZ2L2LX6DWD5JMTLHNCVYTSOD3BLVSXZRUCJZ'
  const runner = Keypair.random()

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  /**
   * Build a settlement transaction and hand it back without letting it reach
   * the network. Simulation is failed on purpose: everything worth asserting
   * has already been decided by the time the transaction is simulated, and
   * failing there guarantees nothing is signed or submitted from a test.
   */
  async function buildSettlement(id: number): Promise<Transaction> {
    vi.stubEnv('NEXT_PUBLIC_VAULT_CONTRACT', VAULT)
    vi.resetModules()

    let captured: Transaction | undefined
    vi.spyOn(rpc.Server.prototype, 'getAccount').mockResolvedValue(
      new Account(runner.publicKey(), '1')
    )
    vi.spyOn(rpc.Server.prototype, 'simulateTransaction').mockImplementation(
      async (tx: any) => {
        captured = tx
        return { error: 'Error(Contract, #6)' } as any
      }
    )
    const send = vi.spyOn(rpc.Server.prototype, 'sendTransaction')

    const { settlePosition } = await import('../vault-contract')
    await expect(settlePosition(id, runner)).rejects.toThrow()

    expect(send).not.toHaveBeenCalled()
    expect(captured).toBeDefined()
    return captured!
  }

  it('invokes settle on the vault, with the position id and nothing else', async () => {
    const tx = await buildSettlement(7)

    expect(tx.operations).toHaveLength(1)
    const op = tx.operations[0] as any
    expect(op.type).toBe('invokeHostFunction')

    const invoke = op.func.invokeContract()
    expect(invoke.functionName().toString()).toBe('settle')

    const args = invoke.args()
    expect(args).toHaveLength(1)
    expect(Number(xdr.ScVal.fromXDR(args[0].toXDR()).u64().toString())).toBe(7)
  })

  it('attaches no authorization entries — it cannot carry a second signature', async () => {
    // This is the structural difference from `open`, which needs the quoter's
    // entry alongside the writer's. A settlement that cannot carry an auth
    // entry cannot smuggle one.
    const tx = await buildSettlement(3)
    const op = tx.operations[0] as any
    expect(op.auth ?? []).toHaveLength(0)
  })

  it('is signed by the runner alone, and only after simulation succeeds', async () => {
    const tx = await buildSettlement(1)
    // Simulation failed, so the transaction was abandoned unsigned. Nothing
    // reaches the network on a path the contract would have rejected anyway.
    expect(tx.signatures).toHaveLength(0)
    expect(tx.source).toBe(runner.publicKey())
  })
})
