/**
 * Meta Ads webhook events — durable inbox + Graph detail resolution.
 *
 * Why this file exists: the webhook path used to be push-only. A parsed event
 * was formatted into a Bangla push and dropped, so a tap on the notification
 * landed in a chat with nothing behind it, and the agent had no record it could
 * read, judge or act on. Meta's own webhook body is a stub too — the real
 * content ("Your Ad Recommendation is ready.") lives on the ad object and must
 * be read back with `fields=recommendations`.
 *
 * Split of responsibility:
 *  - the webhook stores the event and pushes a pointer (fast, no Graph call, so
 *    Meta always gets its 200 quickly);
 *  - the growth page / the agent resolve the detail on demand and cache it.
 */
import { prisma } from '@/lib/prisma'
import { resilientFetch } from '@/agent/lib/fetch-retry'
import { metaGraphBase } from '@/agent/lib/marketing/meta-version'
import type { ParsedAdsEvent } from '@/agent/lib/marketing/ads-webhooks'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** Same logical event re-pushes at most once a day (Meta re-sends far more). */
export const RENOTIFY_WINDOW_MS = 24 * 60 * 60 * 1000
/** Cached Graph detail older than this is refetched on the next open. */
export const DETAIL_TTL_MS = 30 * 60 * 1000

export type AdsEventStatus = 'new' | 'seen' | 'actioned' | 'dismissed'
export const OPEN_STATUSES: AdsEventStatus[] = ['new', 'seen']

export type AdsEventRecord = {
  id: string
  dedupeKey: string
  field: string
  recommendationType: string | null
  recommendationHash: string | null
  adAccountId: string | null
  adObjectIds: string[]
  metaMessage: string | null
  title: string
  message: string
  tier: number
  status: AdsEventStatus
  detail: AdObjectDetail[] | null
  detailFetchedAt: string | null
  detailError: string | null
  notifyCount: number
  lastNotifiedAt: string | null
  lastSeenAt: string
  resolvedAt: string | null
  resolvedNote: string | null
  createdAt: string
}

/** One ad object's Graph read: its identity plus Meta's own recommendations. */
export type AdObjectDetail = {
  objectId: string
  name?: string | null
  effectiveStatus?: string | null
  recommendations: Array<{
    code?: number | string
    title?: string
    message?: string
    importance?: string
    confidence?: string
    blameField?: string
  }>
  error?: string
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((v) => String(v)).filter(Boolean)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shape(row: any): AdsEventRecord {
  return {
    id: String(row.id),
    dedupeKey: String(row.dedupeKey),
    field: String(row.field),
    recommendationType: row.recommendationType ?? null,
    recommendationHash: row.recommendationHash ?? null,
    adAccountId: row.adAccountId ?? null,
    adObjectIds: toStringArray(row.adObjectIds),
    metaMessage: row.metaMessage ?? null,
    title: String(row.title),
    message: String(row.message),
    tier: Number(row.tier ?? 1),
    status: (row.status ?? 'new') as AdsEventStatus,
    detail: Array.isArray(row.detail) ? (row.detail as AdObjectDetail[]) : null,
    detailFetchedAt: row.detailFetchedAt ? new Date(row.detailFetchedAt).toISOString() : null,
    detailError: row.detailError ?? null,
    notifyCount: Number(row.notifyCount ?? 0),
    lastNotifiedAt: row.lastNotifiedAt ? new Date(row.lastNotifiedAt).toISOString() : null,
    lastSeenAt: new Date(row.lastSeenAt ?? row.createdAt).toISOString(),
    resolvedAt: row.resolvedAt ? new Date(row.resolvedAt).toISOString() : null,
    resolvedNote: row.resolvedNote ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Write path (webhook)
// ---------------------------------------------------------------------------

export type RecordedAdsEvent = {
  id: string | null
  /** false → the owner already handled this, or was told within the last day. */
  shouldPush: boolean
  /** true when the DB was unreachable; caller falls back to its KV dedupe. */
  degraded: boolean
}

/**
 * Upsert one parsed event. The SAME Meta event always lands on ONE row, so a
 * recommendation the owner dismissed can never come back as a fresh push, and a
 * still-open one nags at most once a day instead of on Meta's schedule.
 */
export async function recordAdsEvent(
  event: ParsedAdsEvent,
  raw: Record<string, unknown>,
): Promise<RecordedAdsEvent> {
  const now = new Date()
  try {
    const existing = await db.agentAdsEvent.findUnique({
      where: { dedupeKey: event.key },
      select: { id: true, status: true, lastNotifiedAt: true, notifyCount: true },
    })

    const wasResolved = Boolean(existing && (existing.status === 'actioned' || existing.status === 'dismissed'))
    // Object-keyed events (delivery status, issues, thresholds) repeat for every
    // LATER change to the same ad — a resolved row must reopen, or an ad that was
    // paused-and-handled today goes silent when it is rejected tomorrow.
    const reopen = wasResolved && event.reopenOnRepeat === true
    // Resolved and content-keyed → the same news; record the re-send, stay silent.
    const stillResolved = wasResolved && !reopen
    const recentlyPushed =
      existing?.lastNotifiedAt && now.getTime() - new Date(existing.lastNotifiedAt).getTime() < RENOTIFY_WINDOW_MS
    // The once-a-day cap exists to stop a STANDING item (a recommendation, a
    // fatigue level) from nagging on Meta's schedule. Object-keyed events are not
    // standing items: reaching here means the caller's occurrence check already
    // decided this is a change that has not been seen, so it pierces the cap.
    const freshOccurrence = event.reopenOnRepeat === true
    const shouldPush = event.push && !stillResolved && (freshOccurrence || !recentlyPushed)

    const common = {
      field: event.field,
      recommendationType: event.recommendationType ?? null,
      recommendationHash: event.recommendationHash ?? null,
      adAccountId: event.adAccountId ?? null,
      adObjectIds: event.adObjectIds ?? [],
      metaMessage: event.metaMessage ?? null,
      title: event.title,
      message: event.message,
      tier: event.tier,
      raw: raw as object,
      lastSeenAt: now,
    }

    const row = await db.agentAdsEvent.upsert({
      where: { dedupeKey: event.key },
      create: {
        dedupeKey: event.key,
        ...common,
        status: 'new',
        // Notification state is stamped by markAdsEventNotified AFTER a channel
        // accepts the alert — never on the attempt.
        notifyCount: 0,
        lastNotifiedAt: null,
      },
      update: {
        ...common,
        // A later change to the same object becomes an open item again, and its
        // cached Graph detail is stale by definition — drop it so the next open
        // re-reads Meta.
        ...(reopen
          ? { status: 'new', resolvedAt: null, resolvedNote: null, detail: null, detailFetchedAt: null }
          : {}),
      },
      select: { id: true },
    })

    return { id: String(row.id), shouldPush, degraded: false }
  } catch (err) {
    console.error('[ads-events] record failed:', err instanceof Error ? err.message : err)
    // Fail-open: the owner still hears about it, the KV dedupe still guards.
    return { id: null, shouldPush: event.push, degraded: true }
  }
}

/**
 * Stamp the notification ONLY once a channel actually took it. The 24h re-notify
 * window is computed from `lastNotifiedAt`, so stamping on attempt would let a
 * push outage silence an urgent rejection alert for a whole day — the failure
 * would look exactly like a delivery.
 */
export async function markAdsEventNotified(id: string): Promise<void> {
  try {
    await db.agentAdsEvent.update({
      where: { id },
      data: { notifyCount: { increment: 1 }, lastNotifiedAt: new Date() },
    })
  } catch (err) {
    console.error('[ads-events] notify stamp failed:', err instanceof Error ? err.message : err)
  }
}

// ---------------------------------------------------------------------------
// Read path (growth page + agent tools)
// ---------------------------------------------------------------------------

export async function listAdsEvents(opts?: {
  status?: 'open' | 'all' | AdsEventStatus
  limit?: number
}): Promise<AdsEventRecord[]> {
  const status = opts?.status ?? 'open'
  const limit = Math.min(Math.max(Number(opts?.limit ?? 20), 1), 100)
  const where =
    status === 'all' ? {} : status === 'open' ? { status: { in: OPEN_STATUSES } } : { status }

  const rows = await db.agentAdsEvent.findMany({
    where,
    orderBy: [{ lastSeenAt: 'desc' }],
    take: limit,
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows.map((r: any) => shape(r))
}

export async function getAdsEvent(id: string): Promise<AdsEventRecord | null> {
  const row = await db.agentAdsEvent.findUnique({ where: { id } })
  return row ? shape(row) : null
}

export async function countOpenAdsEvents(): Promise<number> {
  try {
    return await db.agentAdsEvent.count({ where: { status: { in: OPEN_STATUSES } } })
  } catch {
    return 0
  }
}

/** Owner/agent decision on one event. `seen` only moves a still-new row. */
export async function setAdsEventStatus(
  id: string,
  status: AdsEventStatus,
  note?: string | null,
): Promise<AdsEventRecord | null> {
  const current = await db.agentAdsEvent.findUnique({ where: { id }, select: { status: true } })
  if (!current) return null

  // `seen` is a read-receipt, not a re-opening: applying it to an already
  // actioned/dismissed row would clear the resolution and let that
  // recommendation start notifying again once the day window lapsed.
  if (status === 'seen' && current.status !== 'new') return await getAdsEvent(id)

  const resolved = status === 'actioned' || status === 'dismissed'
  const row = await db.agentAdsEvent.update({
    where: { id },
    data: {
      status,
      resolvedAt: resolved ? new Date() : null,
      resolvedNote: resolved ? (note ?? null) : null,
    },
  })
  return row ? shape(row) : null
}

// ---------------------------------------------------------------------------
// Graph detail — the actual content behind Meta's stub message
// ---------------------------------------------------------------------------

type GraphRecommendation = {
  code?: number | string
  title?: string
  message?: string
  importance?: string
  confidence?: string
  blame_field?: string
}

/**
 * Read one ad object (campaign / ad set / ad — the field exists on all three).
 * `recommendations` is Meta's documented way to read back what a recommendation
 * actually says; the webhook only carries a hash and a stub sentence.
 */
async function fetchOneObject(objectId: string, token: string): Promise<AdObjectDetail> {
  try {
    const url =
      `${metaGraphBase()}/${encodeURIComponent(objectId)}` +
      `?fields=id,name,effective_status,recommendations&access_token=${encodeURIComponent(token)}`
    const res = await resilientFetch(url, { timeoutMs: 15_000, retries: 1 })
    const data = (await res.json()) as {
      id?: string
      name?: string
      effective_status?: string
      recommendations?: GraphRecommendation[]
      error?: { message?: string }
    }
    if (data.error) return { objectId, recommendations: [], error: data.error.message ?? 'Graph error' }
    return {
      objectId,
      name: data.name ?? null,
      effectiveStatus: data.effective_status ?? null,
      recommendations: (data.recommendations ?? []).map((r) => ({
        code: r.code,
        title: r.title,
        message: r.message,
        importance: r.importance,
        confidence: r.confidence,
        blameField: r.blame_field,
      })),
    }
  } catch (err) {
    return { objectId, recommendations: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Resolve (and cache) the Graph detail for one stored event. Cheap and lazy:
 * the webhook never calls this, so Meta's callback stays fast.
 */
export async function resolveAdsEventDetail(
  id: string,
  opts?: { force?: boolean },
): Promise<AdsEventRecord | null> {
  const event = await getAdsEvent(id)
  if (!event) return null

  const fresh =
    event.detailFetchedAt && Date.now() - new Date(event.detailFetchedAt).getTime() < DETAIL_TTL_MS
  if (!opts?.force && fresh && event.detail) return event

  const token = process.env.META_ADS_TOKEN
  if (!token) {
    const row = await db.agentAdsEvent.update({
      where: { id },
      data: { detailError: 'META_ADS_TOKEN সেট করা নেই', detailFetchedAt: new Date() },
    })
    return shape(row)
  }
  if (!event.adObjectIds.length) {
    const row = await db.agentAdsEvent.update({
      where: { id },
      data: { detailError: 'Meta কোনো অ্যাড অবজেক্ট আইডি পাঠায়নি', detailFetchedAt: new Date() },
    })
    return shape(row)
  }

  // Cap the fan-out — one webhook can name many objects and this runs on a
  // request path.
  const ids = event.adObjectIds.slice(0, 10)
  const detail = await Promise.all(ids.map((objectId) => fetchOneObject(objectId, token)))
  const allFailed = detail.length > 0 && detail.every((d) => d.error)

  const row = await db.agentAdsEvent.update({
    where: { id },
    data: {
      detail,
      detailFetchedAt: new Date(),
      detailError: allFailed ? (detail[0]?.error ?? 'Graph পড়া যায়নি') : null,
    },
  })
  return shape(row)
}
