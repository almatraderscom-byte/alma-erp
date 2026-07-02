/**
 * Google Business Profile (Growth Feature 7) — local Dhaka discovery. Reads
 * reviews and (approval-gated elsewhere) posts replies/updates on the owner's
 * Business Profile. Reuses the shared Google OAuth (gsc.ts); the consent now
 * also requests business.manage (GBP's only scope — no read-only variant).
 *
 * REST, no SDK, mirroring gsc.ts/ga4.ts:
 * - accounts:   mybusinessaccountmanagement.googleapis.com/v1/accounts
 * - locations:  mybusinessbusinessinformation.googleapis.com/v1/{acct}/locations
 * - reviews:    mybusiness.googleapis.com/v4/{acct}/{loc}/reviews (legacy v4 is
 *               still the ONLY reviews endpoint Google offers)
 * - replies:    PUT  …/reviews/{id}/reply
 * - localPosts: POST mybusiness.googleapis.com/v4/{acct}/{loc}/localPosts
 *
 * Honest-failure model: Google gates GBP APIs behind per-project enablement AND
 * a manual access-request form; until the owner's GCP project is approved these
 * calls 403. Every helper returns tagged errors so the tools can tell the owner
 * exactly which step is missing instead of a raw 403.
 */
import { getConnectedGoogleAccessToken } from '@/agent/lib/gsc'

const ACCT_BASE = 'https://mybusinessaccountmanagement.googleapis.com/v1'
const INFO_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1'
const V4_BASE = 'https://mybusiness.googleapis.com/v4'

export type GbpErrorKind = 'not_connected' | 'scope_missing' | 'api_disabled' | 'no_location' | 'error'
export type GbpResult<T> = { ok: true; data: T } | { ok: false; kind: GbpErrorKind; error: string }

export const GBP_ERRORS: Record<Exclude<GbpErrorKind, 'error' | 'no_location'>, string> = {
  not_connected:
    'Google যুক্ত করা নেই। ALMA Agent → 🔍 Growth পেজ থেকে owner একবার connect করলে GBP data আসবে।',
  scope_missing:
    'Google connection-এ Business Profile permission নেই (আগে connect করা হয়েছিল)। Growth পেজ থেকে আবার ' +
    '"connect" করলে GBP access যুক্ত হবে — GSC/GA4 ঠিক থাকবে।',
  api_disabled:
    'GCP project-এ Business Profile API চালু/অনুমোদিত নেই। Google Cloud Console → APIs & Services-এ ' +
    '"My Business Account Management API", "My Business Business Information API" enable করুন এবং ' +
    'Business Profile APIs access request form (developers.google.com/my-business) একবার submit করুন।',
}

async function gbpFetch(url: string, init?: RequestInit): Promise<GbpResult<unknown>> {
  let token: string
  try {
    token = await getConnectedGoogleAccessToken()
  } catch {
    return { ok: false, kind: 'not_connected', error: GBP_ERRORS.not_connected }
  }
  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    return { ok: false, kind: 'error', error: `GBP request failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (res.status === 403 && /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient.*scope/i.test(text)) {
      return { ok: false, kind: 'scope_missing', error: GBP_ERRORS.scope_missing }
    }
    if ((res.status === 403 && /SERVICE_DISABLED|has not been used|disabled|PERMISSION_DENIED/i.test(text)) || res.status === 429) {
      return { ok: false, kind: 'api_disabled', error: GBP_ERRORS.api_disabled }
    }
    return { ok: false, kind: 'error', error: `GBP ${res.status}: ${text.slice(0, 300)}` }
  }
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}))
  return { ok: true, data }
}

export type GbpLocationRef = { account: string; location: string; title: string }

/**
 * Resolve the (account, location) pair. Env overrides (GBP_ACCOUNT_ID /
 * GBP_LOCATION_ID, values like "accounts/123" / "locations/456") skip the two
 * discovery calls; otherwise auto-pick the first account's first location.
 */
export async function resolveGbpLocation(): Promise<GbpResult<GbpLocationRef>> {
  const envAcct = (process.env.GBP_ACCOUNT_ID ?? '').trim()
  const envLoc = (process.env.GBP_LOCATION_ID ?? '').trim()
  if (envAcct && envLoc) {
    return { ok: true, data: { account: envAcct, location: envLoc, title: '(env-configured)' } }
  }

  const accts = await gbpFetch(`${ACCT_BASE}/accounts`)
  if (!accts.ok) return accts
  const accounts = (accts.data as { accounts?: Array<{ name?: string }> }).accounts ?? []
  const account = accounts[0]?.name
  if (!account) return { ok: false, kind: 'no_location', error: 'এই Google account-এ কোনো Business Profile account নেই।' }

  const locs = await gbpFetch(`${INFO_BASE}/${account}/locations?readMask=name,title&pageSize=10`)
  if (!locs.ok) return locs
  const locations = (locs.data as { locations?: Array<{ name?: string; title?: string }> }).locations ?? []
  const loc = locations[0]
  if (!loc?.name) return { ok: false, kind: 'no_location', error: 'Business Profile-এ কোনো location পাওয়া যায়নি।' }

  return { ok: true, data: { account, location: loc.name, title: loc.title ?? '' } }
}

export type GbpReview = {
  reviewId: string
  reviewer: string
  starRating: string
  comment: string
  createTime: string
  hasReply: boolean
  replyComment?: string
}

export async function listGbpReviews(limit = 10): Promise<GbpResult<{ locationTitle: string; averageRating?: number; totalReviewCount?: number; reviews: GbpReview[] }>> {
  const ref = await resolveGbpLocation()
  if (!ref.ok) return ref
  const { account, location, title } = ref.data
  const locId = location.startsWith('locations/') ? location : `locations/${location.split('/').pop()}`
  const r = await gbpFetch(`${V4_BASE}/${account}/${locId}/reviews?pageSize=${Math.min(Math.max(limit, 1), 50)}`)
  if (!r.ok) return r
  const data = r.data as {
    averageRating?: number
    totalReviewCount?: number
    reviews?: Array<{
      reviewId?: string
      reviewer?: { displayName?: string }
      starRating?: string
      comment?: string
      createTime?: string
      reviewReply?: { comment?: string }
    }>
  }
  return {
    ok: true,
    data: {
      locationTitle: title,
      averageRating: data.averageRating,
      totalReviewCount: data.totalReviewCount,
      reviews: (data.reviews ?? []).map((rv) => ({
        reviewId: rv.reviewId ?? '',
        reviewer: rv.reviewer?.displayName ?? '(anonymous)',
        starRating: rv.starRating ?? '',
        comment: rv.comment ?? '',
        createTime: rv.createTime ?? '',
        hasReply: Boolean(rv.reviewReply),
        replyComment: rv.reviewReply?.comment,
      })),
    },
  }
}

/** PUT the owner's reply on a review. Called ONLY from the approve route. */
export async function replyToGbpReview(reviewId: string, comment: string): Promise<GbpResult<unknown>> {
  const ref = await resolveGbpLocation()
  if (!ref.ok) return ref
  const { account, location } = ref.data
  const locId = location.startsWith('locations/') ? location : `locations/${location.split('/').pop()}`
  return gbpFetch(`${V4_BASE}/${account}/${locId}/reviews/${encodeURIComponent(reviewId)}/reply`, {
    method: 'PUT',
    body: JSON.stringify({ comment }),
  })
}

/** Create a "What's New" local post. Called ONLY from the approve route. */
export async function createGbpPost(input: { summary: string; ctaUrl?: string }): Promise<GbpResult<unknown>> {
  const ref = await resolveGbpLocation()
  if (!ref.ok) return ref
  const { account, location } = ref.data
  const locId = location.startsWith('locations/') ? location : `locations/${location.split('/').pop()}`
  const body: Record<string, unknown> = {
    languageCode: 'bn',
    topicType: 'STANDARD',
    summary: input.summary,
  }
  if (input.ctaUrl) body.callToAction = { actionType: 'LEARN_MORE', url: input.ctaUrl }
  return gbpFetch(`${V4_BASE}/${account}/${locId}/localPosts`, { method: 'POST', body: JSON.stringify(body) })
}
