import crypto from 'crypto'

interface Challenge {
  address: string
  nonce: string
  expiresAt: number
}

interface Session {
  address: string
  expiresAt: number
}

const challenges = new Map<string, Challenge>()
const sessions = new Map<string, Session>()

const CHALLENGE_TTL = 120_000 // 2 minutes
const SESSION_TTL = 3600_000  // 1 hour

// Cleanup expired entries every minute
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of challenges) if (v.expiresAt < now) challenges.delete(k)
  for (const [k, v] of sessions) if (v.expiresAt < now) sessions.delete(k)
}, 60_000)

export function createChallenge(address: string): { challengeId: string; nonce: string } {
  const challengeId = crypto.randomBytes(16).toString('hex')
  const nonce = crypto.randomBytes(32).toString('hex')
  challenges.set(challengeId, {
    address,
    nonce,
    expiresAt: Date.now() + CHALLENGE_TTL,
  })
  return { challengeId, nonce }
}

export function consumeChallenge(challengeId: string): Challenge | null {
  const c = challenges.get(challengeId)
  if (!c || c.expiresAt < Date.now()) {
    challenges.delete(challengeId)
    return null
  }
  challenges.delete(challengeId)
  return c
}

export function createSession(address: string): string {
  const token = crypto.randomBytes(32).toString('hex')
  sessions.set(token, { address, expiresAt: Date.now() + SESSION_TTL })
  return token
}

export function validateSession(token: string): string | null {
  const s = sessions.get(token)
  if (!s || s.expiresAt < Date.now()) {
    sessions.delete(token)
    return null
  }
  return s.address
}
