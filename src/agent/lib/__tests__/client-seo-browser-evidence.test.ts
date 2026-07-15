import { describe, expect, it } from 'vitest'
import { extractClientSeoBrowserEvidenceUrl } from '@/agent/lib/client-seo-browser-evidence'

describe('client SEO browser evidence URL', () => {
  it('uses the observed URL before any requested navigation fallback', () => {
    expect(extractClientSeoBrowserEvidenceUrl(
      { url: 'https://one.com' },
      { page: { url: 'https://one.com/about' } },
    )).toBe('https://one.com/about')
  })

  it('accepts the requested URL only for a successful look result', () => {
    expect(extractClientSeoBrowserEvidenceUrl({ url: 'https://one.com' }, {})).toBe('https://one.com')
    expect(extractClientSeoBrowserEvidenceUrl({}, { textError: 'about:blank' })).toBe('')
  })
})
