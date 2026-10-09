import { NextResponse } from 'next/server'
import { revokeSession, validateSession } from '@/lib/admin-sessions'
import { isAdmin } from '@/lib/db-queries'

// How long one allowlist answer is reused. Removing a wallet from the allowlist
// is how access is revoked, so a session has to notice within seconds — not at
// the end of its hour, which is what it did when only the token was checked.
const ALLOWLIST_TTL_MS = 10_000
const allowlist = new Map<string, { ok: boolean; at: number }>()

async function stillAdmin(address: string): Promise<boolean> {
  const hit = allowlist.get(address)
  if (hit && Date.now() - hit.at < ALLOWLIST_TTL_MS) return hit.ok
  const ok = await isAdmin(address)
  allowlist.set(address, { ok, at: Date.now() })
  return ok
}

/**
 * Validate admin access via x-admin-token header (session token from wallet signature auth).
 * Returns the admin address if authorized, or a NextResponse error if not.
 *
 * The session proves who signed in; the allowlist decides whether they still
 * may. Both are checked on every request, and a session whose wallet has left
 * the allowlist is ended rather than left to expire.
 */
export async function requireAdmin(req: Request): Promise<string | NextResponse> {
  const token = req.headers.get('x-admin-token')

  if (!token) {
    return NextResponse.json({ error: 'not authorized' }, { status: 403 })
  }

  const address = validateSession(token)
  if (!address) {
    return NextResponse.json({ error: 'session expired' }, { status: 401 })
  }

  if (!(await stillAdmin(address))) {
    revokeSession(token)
    return NextResponse.json({ error: 'not authorized' }, { status: 403 })
  }

  return address
}

/** Whether the request carries a live admin session, for routes that only
 *  show admins more. */
export async function isAdminRequest(req: Request): Promise<boolean> {
  return typeof (await requireAdmin(req)) === 'string'
}
