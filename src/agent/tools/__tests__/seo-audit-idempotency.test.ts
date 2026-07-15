import { describe, expect, it } from 'vitest'
import {
  normalizeAuditUrl,
  ownerExplicitlyRequestedFreshAudit,
  seoAuditDedupeKey,
} from '@/agent/lib/seo-audit-idempotency'

describe('SEO audit logical idempotency', () => {
  it('normalizes equivalent URLs to one task key', () => {
    expect(normalizeAuditUrl('https://QUEENSPABD.com/')).toBe('https://queenspabd.com')
    expect(normalizeAuditUrl('https://queenspabd.com/?retry=1#top')).toBe('https://queenspabd.com')
  })

  it('gives retries the same bounded database key', () => {
    const url = normalizeAuditUrl('https://queenspabd.com/?retry=2')
    expect(seoAuditDedupeKey('conversation-1', url)).toBe(seoAuditDedupeKey('conversation-1', 'https://queenspabd.com'))
    expect(seoAuditDedupeKey('conversation-1', url)).not.toBe(seoAuditDedupeKey('conversation-2', url))
    expect(seoAuditDedupeKey('conversation-1', url, 'owner-message:2'))
      .not.toBe(seoAuditDedupeKey('conversation-1', url, 'owner-message:1'))
  })

  it('does not trust the model force flag without explicit owner re-audit wording', () => {
    expect(ownerExplicitlyRequestedFreshAudit([{ type: 'text', text: 'এই website full SEO audit করো' }])).toBe(false)
    expect(ownerExplicitlyRequestedFreshAudit([{ type: 'text', text: 'fix শেষ, এখন আবার SEO audit করো' }])).toBe(true)
  })
})
