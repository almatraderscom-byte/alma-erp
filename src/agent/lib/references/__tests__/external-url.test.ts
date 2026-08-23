import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildExternalReference,
  buildVerifiedMetaObjectReference,
  canonicalYouTubeUrlFromVerifiedId,
  extractUserProvidedReferences,
  isCanonicalMetaObjectUrl,
  normalizeYouTubeUrl,
  validateAndSanitizeExternalUrl,
} from '../external-url'

const originalRollout = process.env.AGENT_REFERENCES_ROLLOUT

function lcg(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0
    return value / 0x1_0000_0000
  }
}

describe('external URL security and canonicalization', () => {
  beforeEach(() => { process.env.AGENT_REFERENCES_ROLLOUT = 'on' })
  afterEach(() => {
    if (originalRollout == null) delete process.env.AGENT_REFERENCES_ROLLOUT
    else process.env.AGENT_REFERENCES_ROLLOUT = originalRollout
  })

  it('allows only HTTP(S), strips secrets/tracking, and blocks redirect parameters', () => {
    const checked = validateAndSanitizeExternalUrl(
      'https://example.com/report.pdf?q=ok&utm_source=mail&access_token=SECRET#private',
    )
    expect(checked).toMatchObject({
      ok: true,
      value: {
        url: 'https://example.com/report.pdf?q=ok',
        provider: 'web',
        strippedQueryKeys: expect.arrayContaining(['utm_source', 'access_token']),
      },
    })

    expect(validateAndSanitizeExternalUrl('https://example.com/go?redirect=https://evil.example')).toEqual({
      ok: false,
      reason: 'unsafe_redirect',
    })
  })

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    '//example.com/path',
    'https://user:pass@example.com/',
    'https://localhost/x',
    'https://service.internal/x',
    'http://127.0.0.1/x',
    'http://127.1/x',
    'http://10.2.3.4/x',
    'http://169.254.169.254/latest/meta-data',
    'http://172.20.1.2/x',
    'http://192.168.1.2/x',
    'http://[::1]/x',
    'http://[::]/x',
    'http://[::ffff:7f00:1]/x',
    'http://[::7f00:1]/x',
    'http://[::127.0.0.1]/x',
    'http://[64:ff9b::7f00:1]/x',
    'http://[2002:7f00:1::]/x',
    'http://[fc00::1]/x',
    'http://[fe80::1]/x',
    'http://[ff02::1]/x',
    'https://xn--pple-43d.com/',
    'https://example.com/a\\b',
    `https://example.com/${'a'.repeat(4_100)}`,
  ])('rejects unsafe destination %s', (url) => {
    expect(validateAndSanitizeExternalUrl(url).ok).toBe(false)
  })

  it('accepts ordinary public IPv6 without weakening private-address rejection', () => {
    expect(validateAndSanitizeExternalUrl('https://[2606:4700:4700::1111]/dns-query'))
      .toMatchObject({ ok: true })
  })

  it('classifies providers narrowly and keeps provider/domain user-visible metadata', () => {
    const cases = [
      ['https://maps.google.com/?q=Dhaka', 'google_maps'],
      ['https://www.google.com/search?q=Dhaka', 'web'],
      ['https://www.facebook.com/alma/posts/123', 'facebook'],
      ['https://www.instagram.com/p/ABC_123/', 'instagram'],
      ['https://www.facebook.com/ads/library/?id=123', 'facebook'],
      ['https://example.com/report.pdf', 'web'],
    ] as const
    for (const [url, provider] of cases) {
      const ref = buildExternalReference({ rawUrl: url, source: 'connector_output' })
      expect(ref?.destination).toMatchObject({ provider })
      expect(ref?.display).toMatchObject({ provider })
    }
  })

  it.each([
    ['https://youtu.be/dQw4w9WgXcQ?t=43', 'video', 'dQw4w9WgXcQ', '43'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=1m2s', 'video', 'dQw4w9WgXcQ', '1m2s'],
    ['https://youtube.com/shorts/dQw4w9WgXcQ?t=8', 'video', 'dQw4w9WgXcQ', '8'],
    ['https://youtube.com/playlist?list=PL1234567890', 'playlist', 'PL1234567890', undefined],
    ['https://youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw/videos', 'channel', 'UC_x5XG1OV2P6uZZ5FSM9Ttw', undefined],
    ['https://youtube.com/@GoogleDevelopers/featured', 'channel', '@GoogleDevelopers', undefined],
    ['https://youtube.com/results?search_query=alma+erp', 'search_result', undefined, undefined],
  ])('normalizes verified YouTube URL %s', (url, objectType, objectId, timestamp) => {
    expect(normalizeYouTubeUrl(url)).toMatchObject({ objectType, objectId, timestamp })
  })

  it('builds a YouTube URL only from a closed verified ID contract', () => {
    expect(canonicalYouTubeUrlFromVerifiedId({ type: 'video', id: 'dQw4w9WgXcQ', timestamp: '90s' }))
      .toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s')
    expect(canonicalYouTubeUrlFromVerifiedId({ type: 'video', id: 'too-short' })).toBeNull()
    expect(canonicalYouTubeUrlFromVerifiedId({ type: 'channel', id: '@GoogleDevelopers' }))
      .toBe('https://www.youtube.com/@GoogleDevelopers')
  })

  it.each([
    ['campaign', '456', 'https://www.facebook.com/adsmanager/manage/campaigns?act=123&selected_campaign_ids=456'],
    ['ad_set', '789', 'https://www.facebook.com/adsmanager/manage/adsets?act=123&selected_adset_ids=789'],
    ['ad', '999', 'https://www.facebook.com/adsmanager/manage/ads?act=123&selected_ad_ids=999'],
    ['creative', '777', 'https://www.facebook.com/adsmanager/manage/creatives?act=123&selected_creative_ids=777'],
    ['commerce_order', 'order_5', 'https://www.facebook.com/commerce/orders/order_5?commerce_account_id=123'],
  ] as const)('requires exact Meta account + %s object identity', (level, objectId, url) => {
    expect(isCanonicalMetaObjectUrl({ rawUrl: url, adAccountId: 'act_123', level, objectId })).toBe(true)
    const ref = buildVerifiedMetaObjectReference({
      rawUrl: url,
      adAccountId: 'act_123',
      level,
      objectId,
      sourceTool: 'meta_ads_get_ad_entities',
      outputPath: `data.${level}.url`,
    })
    expect(ref?.entity).toMatchObject({ accountId: 'act_123', level, id: objectId })
    expect(ref?.openMode).toBe('universal_link_first')
    expect(buildVerifiedMetaObjectReference({
      rawUrl: url.replace(/(?:act|commerce_account_id)=123/, (match) => match.replace('123', '124')),
      adAccountId: 'act_123',
      level,
      objectId,
      sourceTool: 'meta_ads_get_ad_entities',
      outputPath: 'data.url',
    })).toBeNull()
  })

  it('extracts only owner-provided safe HTTP(S) URLs and deduplicates them', () => {
    const refs = extractUserProvidedReferences(
      'দেখুন https://example.com/a?utm_source=x, আবার https://example.com/a?utm_source=x এবং http://127.0.0.1/x',
    )
    expect(refs).toHaveLength(1)
    expect(refs[0].provenance.source).toBe('user_provided')
    expect(refs[0].destination).toMatchObject({ url: 'https://example.com/a' })
  })

  it('never throws and accepted canonical URLs are idempotent across 2,000 seeded cases', () => {
    const random = lcg(0xA11A)
    const atoms = ['example.com', '127.0.0.1', 'xn--evil-9ta.com', 'youtube.com', 'a.local', '[::1]']
    const schemes = ['https', 'http', 'javascript', 'file']
    for (let index = 0; index < 2_000; index++) {
      const host = atoms[Math.floor(random() * atoms.length)]
      const scheme = schemes[Math.floor(random() * schemes.length)]
      const key = random() < 0.25 ? 'access_token' : random() < 0.25 ? 'redirect' : 'q'
      const raw = `${scheme}://${host}/p${Math.floor(random() * 10_000)}?${key}=v${Math.floor(random() * 999)}`
      expect(() => validateAndSanitizeExternalUrl(raw)).not.toThrow()
      const first = validateAndSanitizeExternalUrl(raw)
      if (!first.ok) continue
      const second = validateAndSanitizeExternalUrl(first.value.url)
      expect(second.ok).toBe(true)
      if (second.ok) expect(second.value.url).toBe(first.value.url)
    }
  })
})
