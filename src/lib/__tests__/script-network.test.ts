import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { resolveNetwork } from '../stellar'

// The operator scripts resolve their network in a plain Node process, the way
// an operator runs them, so that is how they are tested: a child `node` in a
// directory of its own, with only the environment the test hands it.
const MODULE = path.resolve(__dirname, '../../../scripts/lib/network.mjs')

const childEnv = (env: Record<string, string>): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '',
  NODE_ENV: 'test',
  ...env,
})

function runScript(body: string, env: Record<string, string>, envFile?: string) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'lusty-net-'))
  if (envFile !== undefined) writeFileSync(path.join(cwd, '.env.local'), envFile)
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import * as n from ${JSON.stringify(MODULE)}\n${body}`],
    { cwd, env: childEnv(env), encoding: 'utf8' },
  )
}

const network = (env: Record<string, string>, envFile?: string) => {
  const r = runScript('console.log(JSON.stringify(n.NETWORK))', env, envFile)
  if (r.status !== 0) throw new Error(r.stderr)
  return JSON.parse(r.stdout)
}

describe('scripts/lib/network', () => {
  it('signs for the same network the app does, from the same variables', () => {
    for (const env of [
      {},
      { NEXT_PUBLIC_STELLAR_NETWORK: 'testnet', NEXT_PUBLIC_HORIZON_URL: 'https://h.example' },
      { NEXT_PUBLIC_STELLAR_NETWORK: 'public', NEXT_PUBLIC_RPC_URL: 'https://rpc.example' },
      {
        NEXT_PUBLIC_STELLAR_NETWORK: 'public',
        NEXT_PUBLIC_RPC_URL: 'https://rpc.example',
        SOROBAN_RPC_URL: 'https://keyed.example',
      },
    ] as Record<string, string>[]) {
      expect(network(env)).toEqual(
        resolveNetwork({
          network: env.NEXT_PUBLIC_STELLAR_NETWORK,
          rpcUrl: env.NEXT_PUBLIC_RPC_URL,
          serverRpcUrl: env.SOROBAN_RPC_URL,
          horizonUrl: env.NEXT_PUBLIC_HORIZON_URL,
        }),
      )
    }
  })

  it('reads .env.local like the app, with exported variables winning', () => {
    const file = 'NEXT_PUBLIC_STELLAR_NETWORK=public\nNEXT_PUBLIC_RPC_URL=https://file.example\n'
    expect(network({}, file)).toMatchObject({ name: 'public', rpcUrl: 'https://file.example' })
    expect(network({ NEXT_PUBLIC_STELLAR_NETWORK: 'testnet' }, file).name).toBe('testnet')
  })

  it('refuses a network it does not know before any script body runs', () => {
    const r = runScript('console.log("ran")', { NEXT_PUBLIC_STELLAR_NETWORK: 'mainnet' })
    expect(r.status).not.toBe(0)
    expect(r.stdout).not.toContain('ran')
    expect(r.stderr).toContain('expected "testnet" or "public"')
  })

  it('stops a testnet-only script on the public network', () => {
    const body = 'n.requireTestnet("mint-lusd.mjs"); console.log("minted")'
    const pub = runScript(body, {
      NEXT_PUBLIC_STELLAR_NETWORK: 'public',
      NEXT_PUBLIC_RPC_URL: 'https://rpc.example',
    })
    expect(pub.status).toBe(1)
    expect(pub.stdout).not.toContain('minted')
    expect(pub.stderr).toContain('mint-lusd.mjs is testnet-only')

    expect(runScript(body, {}).stdout).toContain('minted')
  })

  it('never asks friendbot for anything off testnet', () => {
    const r = runScript(
      'globalThis.fetch = () => { console.log("fetched") }; await n.friendbot("GABC")',
      { NEXT_PUBLIC_STELLAR_NETWORK: 'public', NEXT_PUBLIC_RPC_URL: 'https://rpc.example' },
    )
    expect(r.status).toBe(1)
    expect(r.stdout).not.toContain('fetched')
  })
})

describe('the testnet-only scripts', () => {
  const ROOT = path.resolve(__dirname, '../../..')
  it.each([
    'mint-lusd.mjs',
    'mint-lbtc.mjs',
    'fund-distributor.mjs',
    'seed-lusd-offers.mjs',
    'seed-route-liquidity.mjs',
    'anchor-bridge-setup.mjs',
  ])('%s refuses the public network before it signs anything', (script) => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'lusty-net-'))
    let out = ''
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', script)], {
        cwd,
        env: childEnv({
          NEXT_PUBLIC_STELLAR_NETWORK: 'public',
          NEXT_PUBLIC_RPC_URL: 'https://rpc.example',
        }),
        encoding: 'utf8',
        stdio: 'pipe',
      })
    } catch (e) {
      const err = e as { status: number; stderr: string }
      expect(err.status).toBe(1)
      out = err.stderr
    }
    expect(out).toContain(`${script} is testnet-only`)
  })
})
