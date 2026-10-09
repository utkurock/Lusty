import { describe, it, expect } from 'vitest'
import { safeHttpUrl } from '../utils'

describe('safeHttpUrl', () => {
  it('passes web addresses', () => {
    expect(safeHttpUrl(' https://news.example/a?b=1 ')).toBe('https://news.example/a?b=1')
    expect(safeHttpUrl('http://news.example/')).toBe('http://news.example/')
  })

  it('refuses script and data URLs however they are spelled', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull()
    expect(safeHttpUrl(' JaVaScRiPt:alert(1)')).toBeNull()
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
  })

  it('refuses what is not a URL at all', () => {
    expect(safeHttpUrl('/relative/path')).toBeNull()
    expect(safeHttpUrl('')).toBeNull()
  })
})
