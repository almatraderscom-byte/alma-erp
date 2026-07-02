import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * GBP integration (Growth Feature 7). Google gates these APIs behind project
 * enablement + a manual access request, so the failure modes ARE the product:
 * each must map to a tagged, owner-actionable Bangla error — never a raw 403.
 */
const tokenMock = vi.fn(async () => 'tok')
vi.mock('@/agent/lib/gsc', () => ({
  getConnectedGoogleAccessToken: () => tokenMock(),
}))

import { resolveGbpLocation, listGbpReviews, replyToGbpReview } from '../gbp'

const prevAcct = process.env.GBP_ACCOUNT_ID
const prevLoc = process.env.GBP_LOCATION_ID

beforeEach(() => {
  tokenMock.mockResolvedValue('tok')
  process.env.GBP_ACCOUNT_ID = 'accounts/111'
  process.env.GBP_LOCATION_ID = 'locations/222'
})
afterEach(() => {
  process.env.GBP_ACCOUNT_ID = prevAcct
  process.env.GBP_LOCATION_ID = prevLoc
  vi.restoreAllMocks()
})

describe('resolveGbpLocation', () => {
  it('uses env overrides without any network call', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy as unknown as typeof fetch)
    const r = await resolveGbpLocation()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toMatchObject({ account: 'accounts/111', location: 'locations/222' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('not_connected when the token mint fails', async () => {
    delete process.env.GBP_ACCOUNT_ID
    delete process.env.GBP_LOCATION_ID
    tokenMock.mockRejectedValueOnce(new Error('not_connected'))
    const r = await resolveGbpLocation()
    expect(r).toMatchObject({ ok: false, kind: 'not_connected' })
  })
})

describe('listGbpReviews', () => {
  it('parses reviews and reply state', async () => {
    const payload = {
      averageRating: 4.6,
      totalReviewCount: 2,
      reviews: [
        { reviewId: 'r1', reviewer: { displayName: 'Rahim' }, starRating: 'FIVE', comment: 'Khub bhalo', createTime: '2026-06-01T00:00:00Z' },
        { reviewId: 'r2', reviewer: {}, starRating: 'TWO', comment: 'Late delivery', createTime: '2026-06-02T00:00:00Z', reviewReply: { comment: 'Sorry!' } },
      ],
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch)
    const r = await listGbpReviews(5)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.averageRating).toBe(4.6)
      expect(r.data.reviews[0]).toMatchObject({ reviewId: 'r1', reviewer: 'Rahim', hasReply: false })
      expect(r.data.reviews[1]).toMatchObject({ reviewId: 'r2', reviewer: '(anonymous)', hasReply: true, replyComment: 'Sorry!' })
    }
  })

  it('maps scope 403 to scope_missing and service-disabled 403 to api_disabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ACCESS_TOKEN_SCOPE_INSUFFICIENT', { status: 403 })) as unknown as typeof fetch)
    expect(await listGbpReviews()).toMatchObject({ ok: false, kind: 'scope_missing' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('SERVICE_DISABLED: My Business API has not been used', { status: 403 })) as unknown as typeof fetch)
    expect(await listGbpReviews()).toMatchObject({ ok: false, kind: 'api_disabled' })
  })
})

describe('replyToGbpReview', () => {
  it('PUTs the reply to the review reply endpoint', async () => {
    const spy = vi.fn(async (url: string, init?: RequestInit) => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', spy as unknown as typeof fetch)
    const r = await replyToGbpReview('r1', 'ধন্যবাদ!')
    expect(r.ok).toBe(true)
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toContain('/accounts/111/locations/222/reviews/r1/reply')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(String(init?.body))).toEqual({ comment: 'ধন্যবাদ!' })
  })
})
