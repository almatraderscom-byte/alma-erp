import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('@/agent/lib/fetch-retry', () => ({ resilientFetch: mockFetch }))
vi.mock('@/agent/lib/storage', () => ({ agentStorageSignedUrl: vi.fn(async (p: string) => `https://signed.example/${p}`) }))

beforeEach(() => {
  vi.clearAllMocks()
  process.env.FB_PAGE_TOKEN_LIFESTYLE = 'test-token-lifestyle-0123456789'
})
afterEach(() => {
  delete process.env.FB_PAGE_TOKEN_LIFESTYLE
})

import {
  IG_FORMAT_SUPPORT,
  igFormatBlocker,
  publishInstagramImage,
  verifyInstagramMedia,
} from '@/agent/lib/meta-instagram'

const PAGE = '1044848232034171'

describe('IG format honesty', () => {
  it('matrix: single_image supported, reel/carousel/story explicitly not', () => {
    expect(IG_FORMAT_SUPPORT.single_image.supported).toBe(true)
    expect(IG_FORMAT_SUPPORT.reel.supported).toBe(false)
    expect(IG_FORMAT_SUPPORT.carousel.supported).toBe(false)
    expect(IG_FORMAT_SUPPORT.story.supported).toBe(false)
  })

  it('igFormatBlocker: null for single_image, Bangla blockers otherwise', () => {
    expect(igFormatBlocker('single_image')).toBeNull()
    expect(igFormatBlocker('reel')).toContain('supported না')
    expect(igFormatBlocker('does_not_exist')).toContain('অজানা')
  })

  it('publishInstagramImage refuses unsupported formats BEFORE any network call', async () => {
    const r = await publishInstagramImage({ pageId: PAGE, caption: 'x', mediaRef: 'generated/a.png', format: 'reel' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('supported না')
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('verifyInstagramMedia — fetch-back delivery truth', () => {
  const resp = (ok: boolean, body: unknown, status = 200) => ({
    ok,
    status,
    text: async () => JSON.stringify(body),
  })

  it('verifies id + permalink round-trip', async () => {
    mockFetch.mockResolvedValueOnce(resp(true, { id: 'm9', permalink: 'https://instagram.com/p/m9', timestamp: '2026-07-17T10:00:00+0000' }))
    const v = await verifyInstagramMedia(PAGE, 'm9')
    expect(v.ok).toBe(true)
    expect(v.permalink).toContain('/p/m9')
  })

  it('id mismatch or API error → not verified', async () => {
    mockFetch.mockResolvedValueOnce(resp(true, { id: 'other' }))
    expect((await verifyInstagramMedia(PAGE, 'm9')).ok).toBe(false)

    mockFetch.mockResolvedValueOnce(resp(false, { error: { message: 'not found' } }, 400))
    const v = await verifyInstagramMedia(PAGE, 'm9')
    expect(v.ok).toBe(false)
    expect(v.error).toContain('400')
  })
})

describe('publishInstagramImage — two-call container→publish', () => {
  const resp = (ok: boolean, body: unknown, status = 200) => ({
    ok,
    status,
    text: async () => JSON.stringify(body),
  })

  it('happy path: account → container → publish → permalink', async () => {
    mockFetch
      .mockResolvedValueOnce(resp(true, { instagram_business_account: { id: 'ig1', username: 'almalifestyle' } })) // account
      .mockResolvedValueOnce(resp(true, { id: 'container1' })) // container
      .mockResolvedValueOnce(resp(true, { id: 'media1' })) // publish
      .mockResolvedValueOnce(resp(true, { permalink: 'https://instagram.com/p/media1' })) // permalink

    const r = await publishInstagramImage({ pageId: PAGE, caption: 'ঈদ কালেকশন', mediaRef: 'generated/a.png' })
    expect(r.success).toBe(true)
    expect(r.mediaId).toBe('media1')
    expect(r.igUsername).toBe('almalifestyle')
  })

  it('no linked IG account → clear Bangla setup guidance, no publish attempt', async () => {
    mockFetch.mockResolvedValueOnce(resp(true, {}))
    const r = await publishInstagramImage({ pageId: PAGE, caption: 'x', mediaRef: 'generated/a.png' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('Instagram Business')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('container failure surfaces Meta error verbatim', async () => {
    mockFetch
      .mockResolvedValueOnce(resp(true, { instagram_business_account: { id: 'ig1' } }))
      .mockResolvedValueOnce(resp(false, { error: { message: 'Invalid image URL' } }, 400))
    const r = await publishInstagramImage({ pageId: PAGE, caption: 'x', mediaRef: 'generated/a.png' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('400')
  })
})
