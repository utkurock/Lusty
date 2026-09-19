/**
 * SEP-10: logging in by signing a challenge with the user's own key.
 *
 * There is no account here, no password and no email. The anchor hands back a
 * transaction that can never be submitted — sequence zero, its own key as the
 * source — the wallet signs it, and the anchor answers with a JWT. Whoever
 * holds the key is the user; that is the whole authentication model.
 */

import { WebAuth } from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE } from '@/lib/stellar'
import { anchorFetch, loadAnchorToml, AnchorError } from './client'
import type { AnchorSession } from './types'

const storageKey = (domain: string, account: string) => `lusty-anchor-jwt:${domain}:${account}`

/** JWTs are read for their expiry only; nothing here trusts their contents. */
function expiryOf(token: string): number {
  try {
    const payload = token.split('.')[1]
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const exp = JSON.parse(json).exp
    return typeof exp === 'number' ? exp : 0
  } catch {
    return 0
  }
}

/** A minute of headroom, so a token cannot expire between check and send. */
function alive(session: AnchorSession): boolean {
  return session.expiresAt > Date.now() / 1000 + 60
}

/**
 * The session lives in sessionStorage, not localStorage: closing the tab ends
 * it. It is a bearer token for a ramp, and it has no business outliving the
 * visit that created it.
 */
export function readSession(domain: string, account: string): AnchorSession | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(storageKey(domain, account))
    if (!raw) return null
    const session = JSON.parse(raw) as AnchorSession
    return alive(session) ? session : null
  } catch {
    return null
  }
}

export function clearSession(domain: string, account: string): void {
  try {
    sessionStorage.removeItem(storageKey(domain, account))
  } catch {
    /* a browser that refuses storage still gets a working, if forgetful, tab */
  }
}

/**
 * Check that a challenge is a challenge before the wallet signs it.
 *
 * This is the step that makes SEP-10 safe to automate. The anchor hands back a
 * transaction and the wallet will sign whatever it is given; an anchor that was
 * malicious, compromised or simply misconfigured could hand back a real
 * transaction — a payment out of the user's own account — and a client that
 * forwards it straight to the wallet has turned a login button into a signing
 * oracle. The user's only defence would be reading XDR in an extension popup.
 *
 * The SDK's own reader enforces the whole rule: sequence zero, the anchor's
 * declared signing key as the source and as a signer, the operations a
 * challenge is allowed to contain and nothing else, this home domain, this web
 * auth domain, and timebounds that are open now. Anything else throws, and
 * nothing reaches the wallet.
 */
function assertIsChallenge(xdr: string, toml: { signingKey: string; homeDomain: string; webAuthEndpoint: string }, account: string): void {
  if (!toml.signingKey) {
    throw new AnchorError('the anchor publishes no SIGNING_KEY to verify its challenge', 0, 'stellar.toml')
  }

  let webAuthDomain: string
  try {
    webAuthDomain = new URL(toml.webAuthEndpoint).host
  } catch {
    throw new AnchorError('the anchor publishes an unreadable WEB_AUTH_ENDPOINT', 0, 'stellar.toml')
  }

  let read: { clientAccountID: string }
  try {
    read = WebAuth.readChallengeTx(
      xdr,
      toml.signingKey,
      NETWORK_PASSPHRASE,
      [toml.homeDomain],
      webAuthDomain
    )
  } catch (e) {
    throw new AnchorError(
      `that is not a valid SEP-10 challenge, so it was not signed: ${(e as Error).message}`,
      0,
      toml.webAuthEndpoint
    )
  }

  // A challenge names the account it authenticates. One naming somebody else is
  // a login for somebody else.
  if (read.clientAccountID !== account) {
    throw new AnchorError(
      'the challenge names a different account than the one connected',
      0,
      toml.webAuthEndpoint
    )
  }
}

/**
 * Run the challenge round trip. `sign` is the connected wallet's signer, so the
 * key never leaves the extension and this code never sees it.
 */
export async function authenticate(
  account: string,
  sign: (xdr: string) => Promise<string>
): Promise<AnchorSession> {
  const toml = await loadAnchorToml()

  const challenge = await anchorFetch<{ transaction: string; network_passphrase?: string }>(
    `${toml.webAuthEndpoint}?account=${account}&home_domain=${toml.homeDomain}`
  )

  // The passphrase the anchor says it wants signed, checked against the one the
  // wallet will actually sign with. They disagree only when the anchor is on
  // another network, and a signature made under the wrong passphrase is either
  // worthless or, on the network it does match, real.
  if (challenge.network_passphrase && challenge.network_passphrase !== NETWORK_PASSPHRASE) {
    throw new AnchorError(
      `the challenge is for another network (${challenge.network_passphrase})`,
      0,
      toml.webAuthEndpoint
    )
  }

  assertIsChallenge(challenge.transaction, toml, account)

  const signed = await sign(challenge.transaction)

  const { token } = await anchorFetch<{ token: string }>(toml.webAuthEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transaction: signed }),
  })

  const session: AnchorSession = { account, token, expiresAt: expiryOf(token) }
  try {
    sessionStorage.setItem(storageKey(toml.homeDomain, account), JSON.stringify(session))
  } catch {
    /* ignore: the session still works, it just will not survive a reload */
  }
  return session
}
