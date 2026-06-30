import { describe, it, expect } from 'vitest'
import { decodeUnicodeEscapes } from '@/agent/lib/decode-unicode-escapes'

describe('decodeUnicodeEscapes — confirm-card summary normalizer', () => {
  it('restores a leading astral emoji from an uppercase surrogate-pair escape (the reported bug)', () => {
    // The exact shape seen in agent_pending_actions.summary for the retargeting card.
    const escaped = '\\uD83C\\uDFAF রিটার্গেটিং Audience তৈরি করবেন?'
    expect(decodeUnicodeEscapes(escaped)).toBe('🎯 রিটার্গেটিং Audience তৈরি করবেন?')
  })

  it('restores the lookalike card emoji (👥)', () => {
    expect(decodeUnicodeEscapes('\\uD83D\\uDC65 Lookalike Audience তৈরি করবেন?')).toBe(
      '👥 Lookalike Audience তৈরি করবেন?',
    )
  })

  it('handles lowercase hex too (JS-style escapes)', () => {
    expect(decodeUnicodeEscapes('\\ud83c\\udfaf')).toBe('🎯')
  })

  it('decodes a BMP escape (e.g. ✅ U+2705) embedded mid-string', () => {
    expect(decodeUnicodeEscapes('Approve \\u2705 করুন')).toBe('Approve ✅ করুন')
  })

  it('leaves clean text with a real emoji untouched (no-op fast path)', () => {
    const clean = '🎯 রিটার্গেটিং Audience তৈরি করবেন?'
    expect(decodeUnicodeEscapes(clean)).toBe(clean)
  })

  it('is idempotent — decoding an already-decoded string changes nothing', () => {
    const escaped = '\\uD83C\\uDFAF রিটার্গেটিং'
    const once = decodeUnicodeEscapes(escaped)
    expect(decodeUnicodeEscapes(once)).toBe(once)
  })

  it('leaves a lone backslash or non-escape text alone', () => {
    expect(decodeUnicodeEscapes('path\\to\\file')).toBe('path\\to\\file')
    expect(decodeUnicodeEscapes('plain bangla লেখা, no escape')).toBe(
      'plain bangla লেখা, no escape',
    )
  })

  it('guards non-string input', () => {
    // @ts-expect-error — deliberately wrong type
    expect(decodeUnicodeEscapes(null)).toBe(null)
    // @ts-expect-error — deliberately wrong type
    expect(decodeUnicodeEscapes(undefined)).toBe(undefined)
  })
})
