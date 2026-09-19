/**
 * SEP-1 discovery and the one fetch wrapper every other call goes through.
 *
 * The anchor serves `access-control-allow-origin: *`, so the browser talks to
 * it directly and Lusty's own API surface stays out of the path entirely. That
 * is also the honest shape of a SEP integration: the user's key is the
 * identity, so a server in the middle would only be a place for a token to
 * leak.
 */

import { NETWORK_PASSPHRASE } from '@/lib/stellar'
import { ANCHOR_ASSET_CODE, ANCHOR_HOME_DOMAIN } from './config'
import type { AnchorCurrency, AnchorToml } from './types'

/** An error the anchor itself reported, carrying what it said verbatim. */
export class AnchorError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string
  ) {
    super(message)
    this.name = 'AnchorError'
  }
}

/**
 * Read the handful of stellar.toml keys the SEPs put at the top level, plus
 * the `[[CURRENCIES]]` blocks.
 *
 * This is not a general TOML parser and does not pretend to be one: the file is
 * a signboard of quoted strings and string arrays, and a dependency to read
 * fifteen lines of it would be a dependency to audit.
 */
function parseToml(text: string): { root: Record<string, string | string[]>; currencies: Record<string, string>[] } {
  const root: Record<string, string | string[]> = {}
  const currencies: Record<string, string>[] = []
  let target: Record<string, any> = root

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    if (line === '[[CURRENCIES]]') {
      const entry: Record<string, string> = {}
      currencies.push(entry)
      target = entry
      continue
    }
    // Any other section (DOCUMENTATION, PRINCIPALS) is read into the root: the
    // keys we want from them do not collide with the ones we want above them.
    if (line.startsWith('[')) {
      target = root
      continue
    }

    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()

    if (value.startsWith('[')) {
      target[key] = [...value.matchAll(/"([^"]*)"/g)].map(m => m[1])
    } else {
      target[key] = value.replace(/^"(.*)"$/, '$1')
    }
  }

  return { root, currencies }
}

let cached: Promise<AnchorToml> | null = null

/** The anchor's signboard, fetched once per page load. */
export function loadAnchorToml(homeDomain = ANCHOR_HOME_DOMAIN): Promise<AnchorToml> {
  if (cached) return cached

  cached = (async () => {
    const url = `https://${homeDomain}/.well-known/stellar.toml`
    // A network failure here is the whole section failing, so it says which
    // domain went quiet rather than passing the browser's bare "Failed to
    // fetch" up to a card that has no other context to offer.
    const res = await fetch(url, { cache: 'no-store' }).catch(() => {
      throw new AnchorError(`${homeDomain} could not be reached`, 0, url)
    })
    if (!res.ok) throw new AnchorError(`${homeDomain} did not serve a stellar.toml (${res.status})`, res.status, url)

    const { root, currencies } = parseToml(await res.text())
    const str = (k: string) => (typeof root[k] === 'string' ? (root[k] as string) : undefined)

    const webAuthEndpoint = str('WEB_AUTH_ENDPOINT')
    const transferServer = str('TRANSFER_SERVER')
    if (!webAuthEndpoint || !transferServer) {
      throw new AnchorError('stellar.toml names no SEP-10 or SEP-6 server', 0, url)
    }

    // The section is testnet, and this is where that is enforced rather than
    // assumed. Everything downstream builds and signs against the passphrase in
    // lib/stellar; an anchor on another network would have the wallet signing
    // for a chain nobody here is watching, and the one that matters is the one
    // holding real money. A home domain pointed somewhere else fails loudly and
    // at the first call, not halfway through a deposit.
    const passphrase = str('NETWORK_PASSPHRASE')
    if (passphrase && passphrase !== NETWORK_PASSPHRASE) {
      throw new AnchorError(
        `${homeDomain} is on a different network (${passphrase}); this section only speaks to ${NETWORK_PASSPHRASE}`,
        0,
        url
      )
    }

    return {
      homeDomain,
      networkPassphrase: passphrase ?? NETWORK_PASSPHRASE,
      signingKey: str('SIGNING_KEY') ?? '',
      webAuthEndpoint,
      transferServer: transferServer.replace(/\/$/, ''),
      kycServer: str('KYC_SERVER')?.replace(/\/$/, ''),
      quoteServer: str('ANCHOR_QUOTE_SERVER')?.replace(/\/$/, ''),
      accounts: (root['ACCOUNTS'] as string[]) ?? [],
      orgName: str('ORG_NAME'),
      orgDescription: str('ORG_DESCRIPTION'),
      currencies: currencies.map(c => ({
        code: c.code,
        issuer: c.issuer,
        displayDecimals: Number(c.display_decimals ?? 7),
        desc: c.desc,
      })),
    }
  })()

  // A failed discovery must not poison the page for the rest of the session.
  cached.catch(() => {
    cached = null
  })

  return cached
}

/** The asset this section ramps, as stellar.toml declares it. */
export async function anchorCurrency(code = ANCHOR_ASSET_CODE): Promise<AnchorCurrency> {
  const toml = await loadAnchorToml()
  const found = toml.currencies.find(c => c.code === code)
  if (!found) throw new AnchorError(`${code} is not listed on ${toml.homeDomain}`, 0, 'stellar.toml')
  return found
}

/** SEP-38 names an on-chain asset `stellar:CODE:ISSUER`. */
export function sep38Asset(currency: AnchorCurrency): string {
  return `stellar:${currency.code}:${currency.issuer}`
}

/**
 * Every call to the anchor. Failures arrive as `{"error": "..."}` with a 4xx,
 * and that sentence is written for the person reading it — "amount below
 * minimum (50.00 TRY)" — so it is surfaced rather than replaced with our own.
 */
export async function anchorFetch<T>(
  url: string,
  init: RequestInit & { token?: string } = {}
): Promise<T> {
  const { token, headers, ...rest } = init
  const res = await fetch(url, {
    ...rest,
    cache: 'no-store',
    headers: {
      ...(headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const said = body && typeof body.error === 'string' ? body.error : `request failed (${res.status})`
    throw new AnchorError(said, res.status, url)
  }
  return body as T
}

/** `?a=1&b=2`, skipping anything the caller left undefined. */
export function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') q.set(k, String(v))
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}
