import { describe, expect, it } from 'vitest'
import { BodyTooLargeError, readJsonCapped, readTextCapped } from '@/lib/request-body'

/** A chunked body with no Content-Length, counting how many bytes were pulled. */
function chunked(chunks: string[]) {
  const enc = new TextEncoder()
  let pulled = 0
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) return controller.close()
      const bytes = enc.encode(chunks[i++])
      pulled += bytes.byteLength
      controller.enqueue(bytes)
    },
  })
  const req = new Request('http://localhost/api/x', { method: 'POST', body, duplex: 'half' } as RequestInit)
  return { req, pulled: () => pulled }
}

describe('readJsonCapped', () => {
  it('parses a body under the cap', async () => {
    const req = new Request('http://localhost/api/x', { method: 'POST', body: '{"a":1}' })
    expect(await readJsonCapped(req, 100)).toEqual({ a: 1 })
  })

  it('returns null for a malformed or empty body, like req.json().catch(() => null)', async () => {
    expect(await readJsonCapped(new Request('http://localhost/api/x', { method: 'POST', body: '{nope' }))).toBeNull()
    expect(await readJsonCapped(new Request('http://localhost/api/x', { method: 'POST' }))).toBeNull()
  })

  it('refuses a declared Content-Length over the cap without reading', async () => {
    const req = new Request('http://localhost/api/x', {
      method: 'POST', body: 'x'.repeat(10), headers: { 'content-length': '1000' },
    })
    await expect(readJsonCapped(req, 100)).rejects.toBeInstanceOf(BodyTooLargeError)
  })

  it('stops a chunked body with no Content-Length at the cap plus one chunk', async () => {
    const { req, pulled } = chunked(Array.from({ length: 100 }, () => '{},'.repeat(100)))
    await expect(readTextCapped(req, 1000)).rejects.toBeInstanceOf(BodyTooLargeError)
    expect(pulled()).toBeLessThanOrEqual(1000 + 300)
  })
})
