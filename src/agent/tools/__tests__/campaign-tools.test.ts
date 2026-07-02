import { describe, it, expect } from 'vitest'
import { normalizeBdPhone, segmentToSmsRecipients, CAMPAIGN_MAX_RECIPIENTS } from '../campaign-tools'
import type { CustomerSegmentResult } from '@/lib/customer-intelligence'

/**
 * Campaign channel (Growth Feature 6) — guards the recipient plumbing that
 * decides WHO real marketing SMS goes to. A bad normalizer here texts a wrong
 * number or double-texts a customer, so this is the part worth pinning.
 */

describe('normalizeBdPhone', () => {
  it('accepts local, +88 and 88 prefixed BD mobiles and canonicalises to 88…', () => {
    expect(normalizeBdPhone('01712345678')).toBe('8801712345678')
    expect(normalizeBdPhone('+8801712345678')).toBe('8801712345678')
    expect(normalizeBdPhone('8801712345678')).toBe('8801712345678')
    expect(normalizeBdPhone('017 1234-5678')).toBe('8801712345678')
  })
  it('rejects non-BD / malformed numbers', () => {
    expect(normalizeBdPhone('01112345678')).toBeNull() // 011 is not a BD mobile prefix
    expect(normalizeBdPhone('12345')).toBeNull()
    expect(normalizeBdPhone('+9715012345678')).toBeNull()
  })
})

describe('segmentToSmsRecipients', () => {
  const seg = (winBack: Array<{ phone: string | null }>): CustomerSegmentResult => ({
    winBack: winBack.map((c, i) => ({ id: `c${i}`, name: `C${i}`, phone: c.phone, ordersCount: 3 })),
    loyal: [],
    atRisk: [],
    newRecent: [],
  })

  it('dedupes customers sharing a phone and drops invalid/missing phones', () => {
    const out = segmentToSmsRecipients(
      seg([{ phone: '01712345678' }, { phone: '+8801712345678' }, { phone: null }, { phone: 'garbage' }]),
      'winBack',
    )
    expect(out).toHaveLength(1)
    expect(out[0].to).toBe('8801712345678')
  })

  it('cap constant stays a sane Vercel-budget number', () => {
    expect(CAMPAIGN_MAX_RECIPIENTS).toBeGreaterThan(0)
    expect(CAMPAIGN_MAX_RECIPIENTS).toBeLessThanOrEqual(100)
  })
})
