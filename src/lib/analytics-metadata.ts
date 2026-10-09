// What an analytics event may carry besides its name. Server side: the client
// half in lib/analytics.ts is a 'use client' module.

const MAX_METADATA_KEYS = 8
const MAX_METADATA_STRING = 128

/** Flat, small, primitive: anything else is dropped rather than stored. */
export function cleanMetadata(raw: unknown): Record<string, string | number | boolean> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_METADATA_KEYS) break
    if (key.length > 32) continue
    if (typeof value === 'string') out[key] = value.slice(0, MAX_METADATA_STRING)
    else if (typeof value === 'number' && isFinite(value)) out[key] = value
    else if (typeof value === 'boolean') out[key] = value
  }
  return Object.keys(out).length ? out : null
}
