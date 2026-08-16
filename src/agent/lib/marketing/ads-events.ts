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
/** Most ad objects read for one event; beyond this the card says how many were left out. */
export const DETAIL_MAX_OBJECTS = 25
/** Concurrent Graph reads per batch — bounded so a wide event can't stampede. */
export const DETAIL_BATCH = 5

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
  opts?: { occurrenceTag?: string | null },
): Promise<RecordedAdsEvent> {
  const now = new Date()
  const occurrenceTag = opts?.occurrenceTag ?? null
  try {
    const existing = await db.agentAdsEvent.findUnique({
      where: { dedupeKey: event.key },
      select: { id: true, status: true, lastNotifiedAt: true, notifyCount: true, occurrenceTag: true },
    })

    // The KV window is short (6h) and capped at 200 keys, so a late redelivery of
    // the SAME entry can outlive it. The tag is persisted on the row precisely so
    // that redelivery cannot masquerade as a new change and reopen a handled alert.
    const freshOccurrence =
      event.reopenOnRepeat === true &&
      (!existing || occurrenceTag === null || existing.occurrenceTag !== occurrenceTag)

    const wasResolved = Boolean(existing && (existing.status === 'actioned' || existing.status === 'dismissed'))
    // Object-keyed events (delivery status, issues, thresholds) repeat for every
    // LATER change to the same ad — a resolved row must reopen, or an ad that was
    // paused-and-handled today goes silent when it is rejected tomorrow.
    const reopen = wasResolved && freshOccurrence
    // Resolved and same-occurrence (or content-keyed) → the same news; record the
    // re-send, stay silent.
    const stillResolved = wasResolved && !reopen
    const recentlyPushed =
      existing?.lastNotifiedAt && now.getTime() - new Date(existing.lastNotifiedAt).getTime() < RENOTIFY_WINDOW_MS
    // The once-a-day cap exists to stop a STANDING item (a recommendation, a
    // fatigue level) from nagging on Meta's schedule. A genuinely new occurrence
    // of an object event is not a nag — it is news — so it pierces the cap.
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
      ...(occurrenceTag ? { occurrenceTag } : {}),
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
        // ANY new occurrence invalidates the cached Graph read — an alert opened
        // while the ad was PAUSED must not still say PAUSED after it is REJECTED
        // inside the 30-minute detail TTL.
        ...(freshOccurrence ? { detail: null, detailFetchedAt: null, detailError: null } : {}),
        // A later change to the same object also becomes an open item again.
        ...(reopen ? { status: 'new', resolvedAt: null, resolvedNote: null } : {}),
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

  // Bounded fan-out — one webhook can name many objects and this runs on a
  // request path. Read in batches up to a hard cap, and when the cap still cuts
  // the list short, SAY SO: a silently partial set reads as the complete one.
  const ids = event.adObjectIds.slice(0, DETAIL_MAX_OBJECTS)
  const detail: AdObjectDetail[] = []
  for (let i = 0; i < ids.length; i += DETAIL_BATCH) {
    const batch = ids.slice(i, i + DETAIL_BATCH)
    detail.push(...(await Promise.all(batch.map((objectId) => fetchOneObject(objectId, token)))))
  }
  const omitted = event.adObjectIds.length - ids.length
  if (omitted > 0) {
    detail.push({
      objectId: 'more',
      name: `আরও ${omitted}টি অ্যাড অবজেক্ট`,
      recommendations: [],
      error: `এই ইভেন্টে মোট ${event.adObjectIds.length}টি অবজেক্ট — প্রথম ${ids.length}টি দেখানো হয়েছে।`,
    })
  }
  const readAttempts = detail.filter((d) => d.objectId !== 'more')
  const allFailed = readAttempts.length > 0 && readAttempts.every((d) => d.error)

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
