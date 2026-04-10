import { NextResponse } from 'next/server'
import { validateSession } from '@/lib/admin-sessions'

/**
 * Validate admin access via x-admin-token header (session token from wallet signature auth).
 * Returns the admin address if authorized, or a NextResponse error if not.
 */
export function requireAdmin(req: Request): string | NextResponse {
  const token = req.headers.get('x-admin-token')

  if (!token) {
    return NextResponse.json({ error: 'not authorized' }, { status: 403 })
  }

  const address = validateSession(token)
  if (!address) {
    return NextResponse.json({ error: 'session expired' }, { status: 401 })
  }

  return address
}
