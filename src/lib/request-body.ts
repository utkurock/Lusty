// Bounded request-body readers for public routes.
//
// `req.json()` and `req.text()` buffer the whole body before anything looks at
// it, and Next applies no size limit to App Router route handlers (its
// middlewareClientMaxBodySize only guards middleware and rewrite proxying). A
// chunked body with no Content-Length therefore lands in this process's heap
// in full, at many times its size once parsed, before any rate limit runs.
// These readers count bytes as they arrive and cancel the stream past the cap.

/** Default cap for the JSON bodies our routes accept; the largest is a few KB. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024

export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`)
    this.name = 'BodyTooLargeError'
  }
}

/**
 * The body as text, refusing more than `maxBytes`. A declared Content-Length
 * over the cap is refused before reading; an undeclared or understated one is
 * caught by the running count, so at most cap plus one chunk is ever pulled.
 */
export async function readTextCapped(req: Request, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<string> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError(maxBytes)
  if (!req.body) return ''

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new BodyTooLargeError(maxBytes)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/**
 * The body parsed as JSON, or null when it is empty or not JSON — the same
 * contract as `req.json().catch(() => null)`. Throws BodyTooLargeError past the
 * cap, so callers can answer 413 rather than treating it as a malformed body.
 */
export async function readJsonCapped<T = any>(req: Request, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<T | null> {
  const text = await readTextCapped(req, maxBytes)
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}
