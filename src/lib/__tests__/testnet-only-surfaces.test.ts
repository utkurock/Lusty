import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The faucet, the swap desk and the USDC bridge pay out of server-held keys
// for test tokens. On the public network they must not exist: every handler
// answers 404 before it reaches a rate limit, the database, Horizon or a key,
// the /swap page is a 404, and the navigation offers neither.

const query = vi.fn()
vi.mock('@/lib/db', () => ({ ensureSchema: vi.fn(), getPool: () => ({ query }) }))
vi.mock('@/lib/db-queries', () => ({ logTransaction: vi.fn() }))
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  usePathname: () => '/earn',
}))
vi.mock('@/components/shared/WalletButton', () => ({ WalletButton: () => null }))
vi.mock('@/components/shared/FaucetButton', () => ({
  FaucetButton: () => createElement('button', null, 'faucet'),
}))

const fetchSpy = vi.fn(async () => {
  throw new Error('a testnet-only route reached the network')
})

function onNetwork(name: 'testnet' | 'public') {
  vi.resetModules()
  vi.stubGlobal('fetch', fetchSpy)
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', name)
  vi.stubEnv('NEXT_PUBLIC_RPC_URL', 'https://rpc.example')
  vi.stubEnv('REFLECTOR_ORACLE_ID', 'CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  fetchSpy.mockClear()
  query.mockClear()
})

const json = (url: string, body: unknown) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

async function handlers() {
  const faucet = await import('@/app/api/faucet/[asset]/route')
  const swap = await import('@/app/api/swap/route')
  const bridge = await import('@/app/api/anchor/bridge/route')
  return {
    'POST /api/faucet/lusd': () =>
      faucet.POST(json('http://t/api/faucet/lusd', { address: 'G' }), {
        params: Promise.resolve({ asset: 'lusd' }),
      }),
    'POST /api/faucet/xlm': () =>
      faucet.POST(json('http://t/api/faucet/xlm', { address: 'G' }), {
        params: Promise.resolve({ asset: 'xlm' }),
      }),
    'GET /api/swap': () => swap.GET(new Request('http://t/api/swap?direction=XLM_TO_LUSD&amount=10')),
    'POST /api/swap': () => swap.POST(json('http://t/api/swap', { txHash: 'x' })),
    'GET /api/anchor/bridge': () =>
      bridge.GET(new Request('http://t/api/anchor/bridge?direction=in&amount=10')),
    'POST /api/anchor/bridge': () => bridge.POST(json('http://t/api/anchor/bridge', {})),
  }
}

describe('on the public network', () => {
  it('answers every testnet-only route with 404 and touches nothing', async () => {
    onNetwork('public')
    for (const [name, call] of Object.entries(await handlers())) {
      const res = await call()
      expect(res.status, name).toBe(404)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  it('has no /swap page', async () => {
    onNetwork('public')
    const { default: SwapLayout } = await import('@/app/swap/layout')
    let thrown: unknown
    try {
      SwapLayout({ children: null })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { digest?: string })?.digest).toMatch(/404/)
  })

  it('offers neither the swap link nor the faucet in the navigation', async () => {
    onNetwork('public')
    const { Navbar } = await import('@/components/layout/Navbar')
    const html = renderToStaticMarkup(createElement(Navbar))
    expect(html).toContain('href="/earn"')
    expect(html).not.toContain('href="/swap"')
    expect(html).not.toContain('faucet')
  })
})

describe('on testnet', () => {
  it('lets the routes past the network gate', async () => {
    onNetwork('testnet')
    for (const [name, call] of Object.entries(await handlers())) {
      const res = await call()
      expect(res.status, name).not.toBe(404)
    }
  })

  it('keeps the /swap page and offers both in the navigation', async () => {
    onNetwork('testnet')
    const { default: SwapLayout } = await import('@/app/swap/layout')
    expect(SwapLayout({ children: 'swap' })).toBe('swap')
    const { Navbar } = await import('@/components/layout/Navbar')
    const html = renderToStaticMarkup(createElement(Navbar))
    expect(html).toContain('href="/swap"')
    expect(html).toContain('faucet')
  })
})
