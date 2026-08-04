import { describe, expect, it } from 'vitest'
import { sanitizeStudioError } from '../studio-errors'

describe('Studio error sanitization', () => {
  it('maps HTTP/provider failures to human Bangla', () => {
    expect(sanitizeStudioError('{"error":{"message":"429 rate_limit_exceeded"}}')).toContain('অনুরোধ')
    expect(sanitizeStudioError('Provider OutOfCredits request_id=req-secret')).toContain('balance')
    expect(sanitizeStudioError(new Error('fetch failed ECONNRESET'))).toContain('সংযোগ')
  })

  it('never echoes internal JSON, URLs, stack traces, or credentials', () => {
    const unsafe = sanitizeStudioError('Error stack https://provider.example?api_key=secret sk-test-secret')
    expect(unsafe).not.toContain('https://')
    expect(unsafe).not.toContain('sk-test')
    expect(unsafe).toContain('চেষ্টা')
  })

  it('preserves concise owner-facing Bangla errors', () => {
    expect(sanitizeStudioError('আগে একটি ছবি আপলোড করুন।')).toBe('আগে একটি ছবি আপলোড করুন।')
  })
})
