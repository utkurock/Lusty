import { randomBytes } from 'crypto'

/**
 * Log an unexpected failure where operators read it, and give the caller a
 * reference to it instead of its text.
 *
 * Public routes used to answer with `e.message`, and an unexpected error is
 * mostly a driver's: a failed Postgres connection names the host and the role,
 * a failed RPC names the endpoint. The reference is printed beside the full
 * error in the server log, so a user who reports it can still be helped.
 */
export function errorRef(where: string, e: unknown): string {
  const ref = randomBytes(4).toString('hex')
  console.error(`${where} [ref ${ref}]`, e)
  return `ref ${ref}`
}

/**
 * An error whose message was written for the person who caused it — "open a
 * trustline first" — as opposed to one that merely passed through.
 */
export class UserFacingError extends Error {}
