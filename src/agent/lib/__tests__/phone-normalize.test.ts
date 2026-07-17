import { describe, it, expect } from 'vitest'
import { normalizeOutboundPhone } from '@/lib/twilio/phone'

describe('normalizeOutboundPhone', () => {
  it('normalizes local and E.164 forms', () => {
    expect(normalizeOutboundPhone('01949489548')).toBe('+8801949489548')
    expect(normalizeOutboundPhone('+880 1949-489548')).toBe('+8801949489548')
    expect(normalizeOutboundPhone('8801949489548')).toBe('+8801949489548')
  })

  it('accepts Bangla numerals (voice transcripts write ০-৯)', () => {
    expect(normalizeOutboundPhone('০১৯৪৯৪৮৯৫৪৮')).toBe('+8801949489548')
    expect(normalizeOutboundPhone('+৮৮০১৯৪৯৪৮৯৫৪৮')).toBe('+8801949489548')
    expect(normalizeOutboundPhone('০১৯৪৯ ৪৮৯ ৫৪৮')).toBe('+8801949489548')
  })

  it('rejects garbage', () => {
    expect(normalizeOutboundPhone('')).toBeNull()
    expect(normalizeOutboundPhone('abc')).toBeNull()
    expect(normalizeOutboundPhone('123')).toBeNull()
  })
})
