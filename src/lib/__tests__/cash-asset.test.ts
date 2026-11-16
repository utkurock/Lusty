import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The cash a put escrows and every premium is paid in is named once, in the
// asset declarations, by code and issuer. On testnet that is the LUSD this
// repository issues; on the public network it is Circle's USDC. Everything
// that names the cash — the SAC a book is constructed with, the trustline a
// writer needs, the routes into it, the payout and position labels — reads it
// from there.

// The SACs, as the asset contract derives them on each network.
const LUSD_SAC_TESTNET = 'CDTMNV7F7P3LUH6LLBTXY4EQYBUYGVGYRC7P73HMFV5PXLO5NE6A74QB'
const USDC_SAC_PUBLIC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const CIRCLE_ISSUER_PUBLIC = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

async function onNetwork(name: 'testnet' | 'public') {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', name)
  vi.stubEnv('NEXT_PUBLIC_RPC_URL', 'https://rpc.example')
  vi.stubEnv('REFLECTOR_ORACLE_ID', 'CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63')
  vi.stubEnv('NEXT_PUBLIC_LUSD_CODE', '')
  vi.stubEnv('NEXT_PUBLIC_LUSD_ISSUER', '')
  vi.stubEnv('NEXT_PUBLIC_USDC_CODE', '')
  vi.stubEnv('NEXT_PUBLIC_USDC_ISSUER', '')
  return {
    assets: await import('../assets'),
    swap: await import('../swap'),
    routing: await import('../routing/allowlist'),
    picker: await import('@/components/shared/StablePicker'),
    payout: (await import('../vault-contract')).settlementPayout,
  }
}

afterEach(() => vi.unstubAllEnvs())

// A call that was assigned: the vault bought the underlying, so it pays cash.
const assignedCall = { side: 'call', collateral: 100, strike: 0.3, outcome: 'assigned' } as const

describe('on the public network', () => {
  it('settles every book in Circle’s USDC', async () => {
    const { assets } = await onNetwork('public')
    expect(assets.CASH).toMatchObject({ code: 'USDC', issuer: CIRCLE_ISSUER_PUBLIC })
    for (const a of assets.allUnderlyings()) {
      expect(a.cash).toEqual(assets.CASH)
      expect(a.contracts.cash).toBe(USDC_SAC_PUBLIC)
    }
  })

  it('asks a writer to trust USDC and labels what it pays as USDC', async () => {
    const { assets, swap, payout } = await onNetwork('public')
    expect(swap.trustlinesRequired(assets.XLM)).toEqual([
      { kind: 'issued', code: 'USDC', issuer: CIRCLE_ISSUER_PUBLIC },
    ])
    expect(payout(assignedCall, assets.XLM)?.asset).toBe('USDC')
  })

  it('offers no USDC route and no second stable, since USDC is the cash', async () => {
    const { routing, picker } = await onNetwork('public')
    expect(routing.routes()).toEqual([])
    expect(picker.STABLES.map((s) => s.code)).toEqual(['USDC'])
  })
})

describe('on testnet', () => {
  it('settles in LUSD at the SAC every testnet book was constructed with', async () => {
    const { assets } = await onNetwork('testnet')
    expect(assets.CASH.code).toBe('LUSD')
    expect(assets.XLM.contracts.cash).toBe(LUSD_SAC_TESTNET)
  })

  it('routes USDC into LUSD and offers both', async () => {
    const { routing, picker, payout, assets } = await onNetwork('testnet')
    expect(routing.routes().map((r) => r.id)).toEqual(['usdc->lusd', 'lusd->usdc'])
    expect(picker.STABLES.map((s) => s.code)).toEqual(['LUSD', 'USDC'])
    expect(payout(assignedCall, assets.XLM)?.asset).toBe('LUSD')
  })
})

// LUSD exists because testnet has no cash worth settling in, so only the
// surfaces that exist for testnet alone may spell it, and the rule that
// refuses it on the public network.
describe('no other source names LUSD', () => {
  const ROOT = path.resolve(__dirname, '../../..')
  const TESTNET_ONLY = new Set([
    'src/lib/assets/validate.ts',
    'src/lib/lusd.ts',
    'src/lib/swap.ts',
    'src/lib/faucet.ts',
    'src/app/api/swap/route.ts',
    'src/app/swap/page.tsx',
    'src/components/shared/FaucetButton.tsx',
  ])
  const tracked = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((p) => /\.(ts|tsx)$/.test(p) && !p.includes('__tests__/') && !TESTNET_ONLY.has(p))

  it('finds it only on the testnet-only surfaces', () => {
    const offenders = tracked.filter((p) => /['"`]LUSD['"`]/.test(readFileSync(path.join(ROOT, p), 'utf8')))
    expect(offenders).toEqual([])
  })
})
