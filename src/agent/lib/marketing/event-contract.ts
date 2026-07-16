/**
 * Phase 43 — ONE event taxonomy for the whole growth stack.
 *
 * Every marketing-relevant business moment (page view → product view → lead →
 * Messenger → order draft → confirmed → delivered → refund → repeat) has one
 * canonical name, one deterministic event id (same logical event from browser
 * AND server dedupes to one), BDT whole-taka value, and normalized/hashed
 * user data. PII never leaves this module un-hashed and never enters logs
 * or fixtures.
 */
import { createHash } from 'crypto'
import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** Canonical funnel taxonomy — the only event names the growth stack speaks. */
export const EVENT_TAXONOMY = {
  page_view: { metaName: 'PageView', stage: 1 },
  product_view: { metaName: 'ViewContent', stage: 2 },
  lead: { metaName: 'Lead', stage: 3 },
  messenger_conversation: { metaName: 'Contact', stage: 3 },
  order_draft: { metaName: 'InitiateCheckout', stage: 4 },
  order_confirmed: { metaName: 'Purchase', stage: 5 },
  order_delivered: { metaName: 'DeliveredOrder', stage: 6 }, // custom event — COD truth
  refund: { metaName: 'RefundedOrder', stage: 7 }, // custom event
  repeat_purchase: { metaName: 'RepeatPurchase', stage: 8 }, // custom event
} as const

export type CanonicalEventName = keyof typeof EVENT_TAXONOMY

export interface CanonicalEvent {
  name: CanonicalEventName
  /** Deterministic — same logical event always produces the same id (dedup key). */
  eventId: string
  source: 'browser' | 'server' | 'erp' | 'import'
  /** Unix seconds, normalized. */
  occurredAt: number
  currency: 'BDT'
  /** Whole taka. */
  valueBdt: number | null
  orderId: string | null
  /** sha256-hashed identifiers only — never raw. */
  userData: HashedUserData | null
  utm: Record<string, string> | null
}

export interface HashedUserData {
  emailSha256?: string
  phoneSha256?: string
  externalIdSha256?: string
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** Lowercase/trim email per Meta normalization rules, then hash. */
export function hashEmail(raw: string): string {
  return sha256(raw.trim().toLowerCase())
}

/**
 * Normalize a Bangladeshi phone to E.164 digits (8801XXXXXXXXX) per Meta rules
 * (country code, no +, no leading zeros), then hash. Returns null when the
 * number cannot be normalized — better no signal than a wrong hash.
 */
export function normalizeBdPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  if (/^8801[3-9]\d{8}$/.test(digits)) return digits
  if (/^01[3-9]\d{8}$/.test(digits)) return `88${digits}`
  if (/^1[3-9]\d{8}$/.test(digits)) return `880${digits}`
  return null
}

export function hashPhone(raw: string): string | null {
  const normalized = normalizeBdPhone(raw)
  return normalized ? sha256(normalized) : null
}

/** Build hashed user_data from raw identifiers. Raw values never leave this function. */
export function buildUserData(raw: { email?: string | null; phone?: string | null; externalId?: string | null }): HashedUserData | null {
  const out: HashedUserData = {}
  if (raw.email?.trim()) out.emailSha256 = hashEmail(raw.email)
  if (raw.phone?.trim()) {
    const h = hashPhone(raw.phone)
    if (h) out.phoneSha256 = h
  }
  if (raw.externalId?.trim()) out.externalIdSha256 = sha256(raw.externalId.trim())
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Deterministic event id: the same logical business moment — regardless of
 * whether the browser Pixel or the server CAPI reports it — hashes to the
 * same id, so Meta (and our ledger) dedupe instead of double-count.
 *
 * Identity = event name + business entity (orderId > entityId) + day bucket.
 * Events without any entity get a caller-supplied dedupKey.
 */
export function deterministicEventId(input: {
  name: CanonicalEventName
  orderId?: string | null
  entityId?: string | null
  dedupKey?: string | null
  occurredAt: number
}): string {
  const entity = input.orderId?.trim() || input.entityId?.trim() || input.dedupKey?.trim()
  if (!entity) {
    throw new Error(`deterministicEventId: event "${input.name}" needs orderId/entityId/dedupKey for a stable identity`)
  }
  const dayBucket = new Date(input.occurredAt * 1000).toISOString().slice(0, 10)
  return sha256(`alma:${input.name}:${entity}:${dayBucket}`).slice(0, 32)
}

/** Normalize any timestamp input to unix seconds; rejects far-future values. */
export function normalizeOccurredAt(input: number | string | Date, nowMs = Date.now()): number {
  let ms: number
  if (input instanceof Date) ms = input.getTime()
  else if (typeof input === 'number') ms = input < 10_000_000_000 ? input * 1000 : input
  else ms = new Date(input).getTime()
  if (!Number.isFinite(ms)) throw new Error('normalizeOccurredAt: invalid timestamp')
  // Allow small clock skew (5 min); anything further in the future is a bug.
  if (ms > nowMs + 5 * 60_000) throw new Error('normalizeOccurredAt: timestamp is in the future')
  return Math.floor(ms / 1000)
}

export interface EventValidation {
  ok: boolean
  errors: string[]
}

/** Contract check every event must pass before it is recorded or sent anywhere. */
export function validateEvent(e: CanonicalEvent): EventValidation {
  const errors: string[] = []
  if (!(e.name in EVENT_TAXONOMY)) errors.push(`unknown event name "${e.name}"`)
  if (e.currency !== 'BDT') errors.push('currency must be BDT')
  if (e.valueBdt !== null) {
    if (!Number.isInteger(e.valueBdt)) errors.push('valueBdt must be whole taka (integer)')
    if ((e.valueBdt as number) < 0) errors.push('valueBdt must be ≥ 0')
  }
  if (!e.eventId || e.eventId.length < 16) errors.push('eventId missing/too short')
  if (!Number.isFinite(e.occurredAt) || e.occurredAt <= 0) errors.push('occurredAt invalid')
  if ((e.name === 'order_confirmed' || e.name === 'order_delivered' || e.name === 'refund') && !e.orderId) {
    errors.push(`${e.name} requires orderId`)
  }
  // PII contract: userData must be hashes, never raw identifiers.
  if (e.userData) {
    for (const [k, v] of Object.entries(e.userData)) {
      if (v && !/^[a-f0-9]{64}$/.test(v)) errors.push(`userData.${k} is not a sha256 hash — raw PII is forbidden`)
    }
  }
  return { ok: errors.length === 0, errors }
}

/** Convenience constructor applying all normalization in one place. */
export function makeEvent(input: {
  name: CanonicalEventName
  source: CanonicalEvent['source']
  occurredAt: number | string | Date
  valueBdt?: number | null
  orderId?: string | null
  entityId?: string | null
  dedupKey?: string | null
  rawUser?: { email?: string | null; phone?: string | null; externalId?: string | null }
  utm?: Record<string, string> | null
}): CanonicalEvent {
  const occurredAt = normalizeOccurredAt(input.occurredAt)
  const event: CanonicalEvent = {
    name: input.name,
    source: input.source,
    occurredAt,
    eventId: deterministicEventId({
      name: input.name,
      orderId: input.orderId,
      entityId: input.entityId,
      dedupKey: input.dedupKey,
      occurredAt,
    }),
    currency: 'BDT',
    valueBdt: input.valueBdt == null ? null : roundMoney(input.valueBdt),
    orderId: input.orderId ?? null,
    userData: input.rawUser ? buildUserData(input.rawUser) : null,
    utm: input.utm ?? null,
  }
  const v = validateEvent(event)
  if (!v.ok) throw new Error(`invalid event: ${v.errors.join('; ')}`)
  return event
}

export type RecordOutcome = 'recorded' | 'deduped'

/**
 * Persist an event into the ledger. A second arrival of the same eventId is
 * marked deduped and NOT double-counted — the reconciliation dashboard reads
 * distinct recorded rows only.
 */
export async function recordEvent(e: CanonicalEvent, status: 'queued' | 'sent' | 'test' = 'queued'): Promise<RecordOutcome> {
  const v = validateEvent(e)
  if (!v.ok) throw new Error(`invalid event: ${v.errors.join('; ')}`)
  const existing = await db.agentMarketingEvent.findUnique({ where: { eventId: e.eventId } })
  if (existing) return 'deduped'
  await db.agentMarketingEvent.create({
    data: {
      eventName: e.name,
      eventId: e.eventId,
      source: e.source,
      occurredAt: new Date(e.occurredAt * 1000),
      currency: e.currency,
      valueBdt: e.valueBdt,
      orderId: e.orderId,
      utm: e.utm ?? undefined,
      status,
    },
  })
  return 'recorded'
}

/** Ledger counts per event name for a window — reconciliation input. */
export async function ledgerCounts(days: number): Promise<Record<string, number>> {
  const since = new Date(Date.now() - days * 86400000)
  const rows = await db.agentMarketingEvent.groupBy({
    by: ['eventName'],
    where: { occurredAt: { gte: since }, status: { not: 'deduped' } },
    _count: { _all: true },
  })
  const out: Record<string, number> = {}
  for (const r of rows) out[r.eventName] = r._count._all
  return out
}
