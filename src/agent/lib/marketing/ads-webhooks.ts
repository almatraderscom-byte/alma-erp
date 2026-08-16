/**
 * Meta Ads Webhooks (2026 ad_account webhooks) — receive + subscribe helpers.
 *
 * Meta pushes an HTTPS POST to our callback whenever a subscribed field changes
 * on the connected ad account: delivery status (effective_status), creative
 * fatigue, new ad recommendations, with-issues objects. Replaces blind polling —
 * the owner hears about a rejected ad or a fatiguing creative in seconds.
 *
 * Receive path: /api/assistant/internal/ads-webhook (GET verify + POST events).
 * Subscribe path (one-time activation, owner-triggered via manage_ads_webhooks
 * tool): app-level POST /<APP_ID>/subscriptions + account-level
 * POST /act_<ID>/subscribed_apps.
 */
import { prisma } from '@/lib/prisma'
import { resilientFetch } from '@/agent/lib/fetch-retry'
import { metaGraphBase } from '@/agent/lib/marketing/meta-version'
import { notifyOwner } from '@/agent/lib/notify-owner'
import { markAdsEventNotified, recordAdsEvent } from '@/agent/lib/marketing/ads-events'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** Fields we subscribe the app to. `subscriptions` covers the new per-account
 * threshold subscriptions endpoint (delivers on ad_account:subscriptions). */
export const ADS_WEBHOOK_FIELDS = [
  'effective_status',
  'creative_fatigue',
  'ad_recommendations',
  'with_issues_ad_objects',
  'subscriptions',
] as const

const DEDUPE_KV_KEY = 'ads_webhook_dedupe_v1'
const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000 // same event repeated within 6h → drop
const DEDUPE_MAX_KEYS = 200

export function adsWebhookCallbackUrl(): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || 'https://alma-erp-six.vercel.app').replace(/\/$/, '')
  return `${base}/api/assistant/internal/ads-webhook`
}

// ---------------------------------------------------------------------------
// Payload types (per Meta ads-webhooks docs, Jul 2026)
// ---------------------------------------------------------------------------

export type AdsWebhookChange = {
  field?: string
  value?: {
    // effective_status arrives as field_changed
    object_id?: string
    object_type?: string
    changed_fields?: string[]
    // creative_fatigue
    adgroup_id?: string
    creative_fatigue_level?: string
    creative_fatigue_message?: string
    // ad_recommendations
    ad_account_id?: string
    ad_object_ids?: string[]
    recommendation_type?: string
    recommendation_message?: string
    recommendation_hash?: string
    recommendation_signature?: string
    recommendation_stage?: string
  }
}

export type AdsWebhookEnvelope = {
  object?: string
  entry?: Array<{
    id?: string
    time?: number
    changes?: AdsWebhookChange[]
  }>
}

export type ParsedAdsEvent = {
  /** dedupe key — stable per logical event */
  key: string
  /** notifyOwner tier: 2 = needs attention now, 1 = routine FYI */
  tier: 1 | 2
  title: string
  message: string
  /** false → log only, no owner push (e.g. in-process noise) */
  push: boolean
  /** Webhook field this came from — kept so the stored row stays queryable. */
  field: string
  /** Meta ad object ids this event points at — what the Graph detail read uses. */
  adObjectIds: string[]
  recommendationType?: string | null
  recommendationHash?: string | null
  adAccountId?: string | null
  /** Meta's own message, verbatim (usually a stub sentence). */
  metaMessage?: string | null
  /**
   * True when the dedupe key identifies an OBJECT rather than a specific piece of
   * news — `status:<type>:<id>` and `issues:<id>` repeat for every later change to
   * the same ad. Resolving one of those must not silence the object forever: a
   * fresh delivery is a NEW state change (paused today, rejected tomorrow), so the
   * row reopens. Content-keyed events (recommendation hash, fatigue level) stay
   * closed once handled — the same key really is the same news.
   */
  reopenOnRepeat?: boolean
}

// ---------------------------------------------------------------------------
// Parse one webhook change into an owner-facing Bangla event
// ---------------------------------------------------------------------------

export function parseAdsWebhookChange(change: AdsWebhookChange): ParsedAdsEvent | null {
  const v = change.value ?? {}
  const field = change.field ?? ''

  // effective_status is delivered via the shared field_changed field
  if (field === 'field_changed' && (v.changed_fields ?? []).includes('effective_status')) {
    const objType = v.object_type === 'campaign' ? 'ক্যাম্পেইন' : v.object_type === 'adset' ? 'অ্যাড সেট' : 'অ্যাড'
    return {
      key: `status:${v.object_type}:${v.object_id}`,
      tier: 2,
      title: 'Meta Ads: ডেলিভারি স্ট্যাটাস বদলেছে',
      message:
        `Boss, ${objType} (ID: ${v.object_id ?? '?'})-এর ডেলিভারি স্ট্যাটাস বদলে গেছে — ` +
        `রিজেক্ট, পজ বা আবার চালু হতে পারে। আমাকে "ads status check koro" বললে এখনই বিস্তারিত এনে দেব।`,
      push: true,
      field,
      adObjectIds: v.object_id ? [String(v.object_id)] : [],
      reopenOnRepeat: true,
    }
  }

  if (field === 'creative_fatigue') {
    const level = (v.creative_fatigue_level ?? '').toUpperCase()
    return {
      key: `fatigue:${v.adgroup_id}:${level}`,
      tier: level === 'HIGH' ? 2 : 1,
      title: `Meta Ads: ক্রিয়েটিভ ক্লান্তি ${level === 'HIGH' ? 'বেশি (HIGH)' : level === 'MEDIUM' ? 'মাঝারি' : 'কম'}`,
      message:
        `Boss, অ্যাড (ID: ${v.adgroup_id ?? '?'})-এর ক্রিয়েটিভ পুরনো হয়ে যাচ্ছে (fatigue: ${level || '?'}) — ` +
        `একই ছবি বারবার দেখে মানুষ আর ক্লিক করছে না। নতুন ছবি/ভিডিও দিয়ে রিফ্রেশ করলে খরচ কমবে। ` +
        `চাইলে আমি নতুন ক্রিয়েটিভ বানিয়ে কার্ড পাঠাতে পারি।`,
      push: level === 'HIGH' || level === 'MEDIUM',
      field,
      adObjectIds: v.adgroup_id ? [String(v.adgroup_id)] : [],
      metaMessage: v.creative_fatigue_message ?? null,
    }
  }

  if (field === 'ad_recommendations') {
    return {
      key: `rec:${v.recommendation_hash || v.recommendation_signature || v.recommendation_type}:${(v.ad_object_ids ?? []).join(',')}`,
      tier: 1,
      title: 'Meta Ads: নতুন সুপারিশ এসেছে',
      message:
        `Boss, Meta নতুন পারফরম্যান্স সুপারিশ দিয়েছে (${v.recommendation_type ?? 'unknown'})। ` +
        `${v.recommendation_message ? `"${v.recommendation_message}" ` : ''}` +
        `অ্যাপে ট্যাপ করলে পুরো সুপারিশটা দেখতে পাবেন, বা "ad recommendation dekho" বললে ` +
        `আমি বিস্তারিত এনে ভালো-মন্দ জানাব।`,
      push: true,
      field,
      adObjectIds: (v.ad_object_ids ?? []).map((x) => String(x)),
      recommendationType: v.recommendation_type ?? null,
      recommendationHash: v.recommendation_hash ?? v.recommendation_signature ?? null,
      adAccountId: v.ad_account_id ?? null,
      metaMessage: v.recommendation_message ?? null,
    }
  }

  if (field === 'with_issues_ad_objects') {
    return {
      key: `issues:${v.object_id ?? JSON.stringify(v).slice(0, 80)}`,
      tier: 2,
      title: 'Meta Ads: অ্যাডে সমস্যা ধরা পড়েছে',
      message:
        `Boss, একটা অ্যাড অবজেক্টে সমস্যা (issue state) ধরা পড়েছে — ডেলিভারি আটকে থাকতে পারে। ` +
        `"ads status check koro" বললে কোনটায় কী সমস্যা বের করে দেব।`,
      push: true,
      field,
      adObjectIds: v.object_id ? [String(v.object_id)] : (v.ad_object_ids ?? []).map((x) => String(x)),
      reopenOnRepeat: true,
    }
  }

  if (field === 'subscriptions') {
    return {
      key: `sub:${JSON.stringify(v).slice(0, 100)}`,
      tier: 1,
      title: 'Meta Ads: থ্রেশহোল্ড অ্যালার্ট',
      message:
        `Boss, আপনার সেট করা অ্যাড থ্রেশহোল্ড/মাইলস্টোনে একটা ঘটনা ঘটেছে। ` +
        `"ads status check koro" বললে বিস্তারিত দেখে জানাব।`,
      push: true,
      field,
      adObjectIds: (v.ad_object_ids ?? []).map((x) => String(x)),
      adAccountId: v.ad_account_id ?? null,
      reopenOnRepeat: true,
    }
  }

  // in_process_ad_objects + unknown fields: log only
  return null
}

// ---------------------------------------------------------------------------
// Dedupe (KV-backed, fail-open)
// ---------------------------------------------------------------------------

type DedupeMap = Record<string, number>

/**
 * Short, stable tag for THIS occurrence — the entry timestamp plus the payload.
 * A Meta retry repeats the entry verbatim (same `time`), so it collapses onto the
 * same tag; a second real change to the object arrives in a new entry with a new
 * `time` and gets its own tag. Payload alone is not enough: two genuine
 * effective_status transitions carry byte-identical `changed_fields`.
 */
function occurrenceTag(value: unknown): string {
  const json = JSON.stringify(value ?? {})
  let hash = 0
  for (let i = 0; i < json.length; i += 1) {
    hash = (hash * 31 + json.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

async function loadDedupe(): Promise<DedupeMap> {
  try {
    const row = await db.agentKvSetting.findUnique({ where: { key: DEDUPE_KV_KEY }, select: { value: true } })
    const parsed = row?.value ? JSON.parse(String(row.value)) : {}
    return parsed && typeof parsed === 'object' ? (parsed as DedupeMap) : {}
  } catch {
    return {}
  }
}

async function saveDedupe(map: DedupeMap): Promise<void> {
  try {
    const now = Date.now()
    const pruned = Object.entries(map)
      .filter(([, ts]) => now - ts < DEDUPE_WINDOW_MS)
      .slice(-DEDUPE_MAX_KEYS)
    const value = JSON.stringify(Object.fromEntries(pruned))
    await db.agentKvSetting.upsert({
      where: { key: DEDUPE_KV_KEY },
      update: { value },
      create: { key: DEDUPE_KV_KEY, value },
    })
  } catch {
    // fail-open: worst case a repeated push
  }
}

// ---------------------------------------------------------------------------
// Main handler — called from the webhook route POST
// ---------------------------------------------------------------------------

export async function handleAdsWebhook(
  envelope: AdsWebhookEnvelope,
): Promise<{ received: number; notified: number; stored: number }> {
  if (envelope.object !== 'ad_account') return { received: 0, notified: 0, stored: 0 }

  // The entry timestamp is what separates a REDELIVERY (Meta resends the same
  // entry, same `time`) from a second real change to the same object (new entry,
  // new `time`) — the payload alone cannot tell them apart, since two genuine
  // effective_status transitions carry identical `changed_fields`.
  const changes = (envelope.entry ?? []).flatMap((e) =>
    (e.changes ?? []).map((change) => ({ change, entryTime: e.time })),
  )
  if (!changes.length) return { received: 0, notified: 0, stored: 0 }

  const dedupe = await loadDedupe()
  const now = Date.now()
  let notified = 0

  let stored = 0
  /** Guards duplicates INSIDE this one request; the KV map guards across requests. */
  const seenThisRequest = new Set<string>()

  for (const { change, entryTime } of changes) {
    const event = parseAdsWebhookChange(change)
    if (!event) continue

    // Layer 1 — KV short-window guard against Meta retry storms. Kept because it
    // still works when the DB is unreachable. It must key on the OCCURRENCE, not
    // the object: `status:<type>:<id>` repeats for every later change to the same
    // ad, so keying on identity alone would swallow a real rejection that lands
    // an hour after a pause.
    const tag = event.reopenOnRepeat ? occurrenceTag({ t: entryTime ?? null, v: change.value }) : null
    const kvKey = tag ? `${event.key}#${tag}` : event.key
    const last = dedupe[kvKey]
    if (last && now - last < DEDUPE_WINDOW_MS) continue
    if (seenThisRequest.has(kvKey)) continue
    seenThisRequest.add(kvKey)

    // Layer 2 — the durable row. This is what the app and the agent read later,
    // and what decides whether the owner hears about it AGAIN: an event he has
    // actioned or dismissed never re-pushes, an open one nags once a day.
    const recorded = await recordAdsEvent(event, (change.value ?? {}) as Record<string, unknown>, {
      occurrenceTag: tag,
    })
    if (!recorded.degraded) stored += 1
    if (!recorded.shouldPush) continue

    try {
      const delivery = await notifyOwner({
        tier: event.tier,
        title: event.title,
        message: event.message,
        category: event.tier === 2 ? 'urgent' : 'task',
        // A tap must land ON the event, not in an empty chat.
        actionUrl: recorded.id ? `/agent/growth?rec=${recorded.id}` : '/agent/growth',
      })
      // Only a real handoff counts. notifyOwner swallows transport errors and
      // reports them in `statuses`, so stamping on return would let one push
      // outage hide an urgent alert for the whole re-notify window.
      const delivered = Object.values(delivery?.statuses ?? {}).some(
        (s) => s === 'sent' || s === 'held',
      )
      if (delivered) {
        notified += 1
        // Suppress Meta's retries of THIS delivery only now — stamping on attempt
        // would let a failed push swallow the retry that would have succeeded.
        dedupe[kvKey] = now
        if (recorded.id) await markAdsEventNotified(recorded.id)
      } else {
        console.error('[ads-webhook] no channel accepted the alert:', JSON.stringify(delivery?.statuses ?? {}))
      }
    } catch (err) {
      console.error('[ads-webhook] notifyOwner failed:', err instanceof Error ? err.message : err)
    }
  }

  await saveDedupe(dedupe)
  return { received: changes.length, notified, stored }
}

// ---------------------------------------------------------------------------
// Activation helpers (subscribe app + connect ad account)
// ---------------------------------------------------------------------------

function appAccessToken(): string {
  const id = process.env.META_APP_ID
  const secret = process.env.META_APP_SECRET
  if (!id || !secret) throw new Error('META_APP_ID / META_APP_SECRET সেট করা নেই')
  return `${id}|${secret}`
}

function adAccountId(): string {
  const raw = (process.env.META_AD_ACCOUNT_ID ?? '').trim()
  if (!raw) throw new Error('META_AD_ACCOUNT_ID সেট করা নেই')
  return raw.startsWith('act_') ? raw : `act_${raw}`
}

/** Step 1 — register app-level subscription (app access token). Meta fires the
 * GET verification at our callback during this call. */
export async function subscribeAppToAdsWebhooks(): Promise<{ ok: boolean; error?: string }> {
  const appId = process.env.META_APP_ID
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN
  if (!appId) return { ok: false, error: 'META_APP_ID সেট করা নেই' }
  if (!verifyToken) return { ok: false, error: 'META_WEBHOOK_VERIFY_TOKEN সেট করা নেই' }

  try {
    const body = new URLSearchParams({
      object: 'ad_account',
      callback_url: adsWebhookCallbackUrl(),
      fields: ADS_WEBHOOK_FIELDS.join(','),
      verify_token: verifyToken,
      access_token: appAccessToken(),
    })
    const res = await resilientFetch(`${metaGraphBase()}/${appId}/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      timeoutMs: 20_000,
      retries: 1,
    })
    const data = (await res.json()) as { success?: boolean; error?: { message?: string } }
    if (data.error) return { ok: false, error: data.error.message ?? 'subscription কল ব্যর্থ' }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Step 2 — connect our ad account so events actually deliver (admin token). */
export async function connectAdAccountToApp(): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.META_ADS_TOKEN
  if (!token) return { ok: false, error: 'META_ADS_TOKEN সেট করা নেই' }

  try {
    const body = new URLSearchParams({ access_token: token })
    const res = await resilientFetch(`${metaGraphBase()}/${adAccountId()}/subscribed_apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      timeoutMs: 20_000,
      retries: 1,
    })
    const data = (await res.json()) as { success?: boolean; error?: { message?: string } }
    if (data.error) return { ok: false, error: data.error.message ?? 'subscribed_apps কল ব্যর্থ' }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export type AdsWebhookStatus = {
  appSubscribed: boolean
  subscribedFields: string[]
  callbackUrl: string | null
  accountConnected: boolean
  error?: string
}

/** Read-only status: what the app is subscribed to + whether our account is connected. */
export async function getAdsWebhookStatus(): Promise<AdsWebhookStatus> {
  const empty: AdsWebhookStatus = { appSubscribed: false, subscribedFields: [], callbackUrl: null, accountConnected: false }
  const appId = process.env.META_APP_ID
  if (!appId) return { ...empty, error: 'META_APP_ID সেট করা নেই' }

  try {
    const subRes = await resilientFetch(
      `${metaGraphBase()}/${appId}/subscriptions?access_token=${encodeURIComponent(appAccessToken())}`,
      { timeoutMs: 15_000, retries: 1 },
    )
    const subData = (await subRes.json()) as {
      data?: Array<{ object?: string; callback_url?: string; fields?: Array<{ name?: string } | string>; active?: boolean }>
      error?: { message?: string }
    }
    if (subData.error) return { ...empty, error: subData.error.message }

    const adAccountSub = (subData.data ?? []).find((s) => s.object === 'ad_account')
    const fields = (adAccountSub?.fields ?? []).map((f) => (typeof f === 'string' ? f : f.name ?? '')).filter(Boolean)

    let accountConnected = false
    const token = process.env.META_ADS_TOKEN
    if (token) {
      try {
        const accRes = await resilientFetch(
          `${metaGraphBase()}/${adAccountId()}/subscribed_apps?access_token=${encodeURIComponent(token)}`,
          { timeoutMs: 15_000, retries: 1 },
        )
        const accData = (await accRes.json()) as { data?: Array<{ id?: string }>; error?: { message?: string } }
        accountConnected = (accData.data ?? []).some((a) => String(a.id) === String(appId))
      } catch {
        // leave false
      }
    }

    return {
      appSubscribed: Boolean(adAccountSub),
      subscribedFields: fields,
      callbackUrl: adAccountSub?.callback_url ?? null,
      accountConnected,
    }
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) }
  }
}
