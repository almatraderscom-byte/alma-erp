import { describe, expect, it } from 'vitest'
import { isPublicPath } from '@/lib/auth-paths'

describe('client auth path classification', () => {
  it('lets the exact server-gated report proof route reach its page guard', () => {
    expect(isPublicPath('/agent/report-preview')).toBe(true)
    expect(isPublicPath('/agent/report-preview?proof=1')).toBe(true)
  })

  it('does not open neighboring agent routes or proof-like descendants', () => {
    expect(isPublicPath('/agent')).toBe(false)
    expect(isPublicPath('/agent/report-preview/private')).toBe(false)
    expect(isPublicPath('/agent/report-preview-copy')).toBe(false)
  })
})
