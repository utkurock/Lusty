import { readdirSync, readFileSync, statSync } from 'fs'
import path from 'path'
import { Networks } from '@stellar/stellar-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveNetwork } from '../stellar'

describe('resolveNetwork', () => {
  it('reads an unset network as testnet, as every deployment before it did', () => {
    const n = resolveNetwork({})
    expect(n.name).toBe('testnet')
    expect(n.passphrase).toBe(Networks.TESTNET)
    expect(n.rpcUrl).toBe('https://soroban-testnet.stellar.org')
    expect(n.horizonUrl).toBe('https://horizon-testnet.stellar.org')
    expect(n.explorerBase).toBe('https://stellar.expert/explorer/testnet')
  })

  it('derives the public passphrase, Horizon and explorer from "public"', () => {
    const n = resolveNetwork({ network: 'public', rpcUrl: 'https://rpc.example' })
    expect(n.passphrase).toBe(Networks.PUBLIC)
    expect(n.horizonUrl).toBe('https://horizon.stellar.org')
    expect(n.rpcUrl).toBe('https://rpc.example')
    expect(n.explorerBase).toBe('https://stellar.expert/explorer/public')
  })

  it.each(['mainnet', 'Testnet', 'futurenet', Networks.PUBLIC])(
    'refuses %j instead of falling back to testnet',
    (network) => {
      expect(() => resolveNetwork({ network })).toThrow(/NEXT_PUBLIC_STELLAR_NETWORK/)
    },
  )

  it('refuses the public network without an RPC the browser can see', () => {
    expect(() => resolveNetwork({ network: 'public' })).toThrow(/NEXT_PUBLIC_RPC_URL/)
    // A server-only RPC would start the server and break every browser.
    expect(() =>
      resolveNetwork({ network: 'public', serverRpcUrl: 'https://keyed.example' }),
    ).toThrow(/NEXT_PUBLIC_RPC_URL/)
  })

  it('lets the server override the shared RPC', () => {
    const n = resolveNetwork({
      network: 'public',
      rpcUrl: 'https://rpc.example',
      serverRpcUrl: 'https://keyed.example',
    })
    expect(n.rpcUrl).toBe('https://keyed.example')
  })
})

describe('the module as the app loads it', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('stops loading on a network it does not know', async () => {
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
    vi.resetModules()
    await expect(import('../stellar')).rejects.toThrow(/expected "testnet" or "public"/)
  })

  it('signs and links for the public network when told to', async () => {
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'public')
    vi.stubEnv('NEXT_PUBLIC_RPC_URL', 'https://rpc.example')
    vi.stubEnv('NEXT_PUBLIC_HORIZON_URL', '')
    vi.resetModules()
    const s = await import('../stellar')
    expect(s.IS_TESTNET).toBe(false)
    expect(s.NETWORK_PASSPHRASE).toBe(Networks.PUBLIC)
    expect(s.HORIZON_URL).toBe('https://horizon.stellar.org')
    expect(s.explorerTxUrl('abc')).toBe('https://stellar.expert/explorer/public/tx/abc')
  })

  it('does not read prices from the testnet oracle on the public network', async () => {
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'public')
    vi.stubEnv('NEXT_PUBLIC_RPC_URL', 'https://rpc.example')
    vi.stubEnv('REFLECTOR_ORACLE_ID', '')
    vi.resetModules()
    await expect(import('../reflector')).rejects.toThrow(/REFLECTOR_ORACLE_ID/)
  })
})

// The point of the module is that nothing else decides the network. A
// passphrase, a testnet endpoint or a hand-built explorer link anywhere else in
// the app is a place a public deployment would still be on testnet.
describe('no other source names a network', () => {
  const SRC = path.resolve(__dirname, '../..')
  const OWNER = path.join(SRC, 'lib/stellar.ts')
  const FORBIDDEN =
    /horizon-testnet|soroban-testnet|horizon\.stellar\.org|Networks\.(TESTNET|PUBLIC)|stellar\.expert\/explorer|stellarchain\.io/

  function* sources(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name)
      if (statSync(p).isDirectory()) {
        if (name !== '__tests__') yield* sources(p)
      } else if (/\.(ts|tsx)$/.test(name) && p !== OWNER) {
        yield p
      }
    }
  }

  it('finds every one of them in lib/stellar', () => {
    const offenders = [...sources(SRC)].filter((p) =>
      FORBIDDEN.test(readFileSync(p, 'utf8')),
    )
    expect(offenders.map((p) => path.relative(SRC, p))).toEqual([])
  })
})
