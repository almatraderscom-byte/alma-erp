/**
 * Phase 43 — Meta Conversions API (server-side events).
 *
 * Browser Pixel + server CAPI report the SAME deterministic event_id
 * (event-contract.ts), so Meta deduplicates instead of double-counting.
 * User data goes out sha256-hashed only; raw PII never enters this module,
 * its logs, or its fixtures.
 *
 * Verification safety: `sendCapiEvents` accepts a testEventCode — test events
 * appear in Events Manager's Test Events tab and never pollute ad optimization.
 * The agent-facing tool path REQUIRES the test code; production sends happen
 * only from server flows wired in later phases.
 */
import {
  EVENT_TAXONOMY,
  recordEvent,
  validateEvent,
  type CanonicalEvent,
} from '@/agent/lib/marketing/event-contract'
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

// Hard-coded version — listed in META_VERSION_CALL_SITES; Phase 45 centralizes.
const GRAPH_BASE = 'https://graph.facebook.com/v21.0'

export function capiConfigured(): boolean {
  return Boolean(process.env.META_PIXEL_ID?.trim() && (process.env.META_CAPI_TOKEN ?? process.env.META_ADS_TOKEN)?.trim())
}

interface MetaServerEvent {
  event_name: string
  event_time: number
  event_id: string
  action_source: 'website' | 'chat' | 'system_generated'
  user_data: Record<string, string[]>
  custom_data?: Record<string, unknown>
}

/** Map canonical events to the Meta CAPI wire format. Pure — fully testable. */
export function buildCapiPayload(events: CanonicalEvent[], opts?: { testEventCode?: string }): {
  data: MetaServerEvent[]
  test_event_code?: string
} {
  const data = events.map((e) => {
    const v = validateEvent(e)
    if (!v.ok) throw new Error(`buildCapiPayload: ${v.errors.join('; ')}`)
    const user_data: Record<string, string[]> = {}
    if (e.userData?.emailSha256) user_data.em = [e.userData.emailSha256]
    if (e.userData?.phoneSha256) user_data.ph = [e.userData.phoneSha256]
    if (e.userData?.externalIdSha256) user_data.external_id = [e.userData.externalIdSha256]
    const wire: MetaServerEvent = {
      event_name: EVENT_TAXONOMY[e.name].metaName,
      event_time: e.occurredAt,
      event_id: e.eventId,
      action_source: e.source === 'browser' ? 'website' : e.name === 'messenger_conversation' ? 'chat' : 'system_generated',
      user_data,
    }
    if (e.valueBdt !== null) {
      wire.custom_data = { currency: 'BDT', value: e.valueBdt, ...(e.orderId ? { order_id: e.orderId } : {}) }
    } else if (e.orderId) {
      wire.custom_data = { order_id: e.orderId }
    }
    return wire
  })
  return opts?.testEventCode ? { data, test_event_code: opts.testEventCode } : { data }
}

export interface CapiSendResult {
  ok: boolean
  sent: number
  deduped: number
  eventsReceived?: number
  error?: string
}

/**
 * Send events to the pixel/dataset. Every event is first recorded in the
 * ledger — an eventId the ledger has already seen is NOT re-sent (idempotent
 * retry safety on top of Meta's own event_id dedup).
 */
export async function sendCapiEvents(events: CanonicalEvent[], opts?: { testEventCode?: string }): Promise<CapiSendResult> {
  if (!capiConfigured()) {
    return { ok: false, sent: 0, deduped: 0, error: 'META_PIXEL_ID / META_CAPI_TOKEN not configured' }
  }
  const fresh: CanonicalEvent[] = []
  let deduped = 0
  for (const e of events) {
    const outcome = await recordEvent(e, opts?.testEventCode ? 'test' : 'queued')
    if (outcome === 'deduped') deduped += 1
    else fresh.push(e)
  }
  if (fresh.length === 0) return { ok: true, sent: 0, deduped }

  const pixelId = process.env.META_PIXEL_ID!.trim()
  const token = (process.env.META_CAPI_TOKEN ?? process.env.META_ADS_TOKEN)!.trim()
  const payload = buildCapiPayload(fresh, opts)

  try {
    const res = await fetch(`${GRAPH_BASE}/${pixelId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, access_token: token }),
      signal: AbortSignal.timeout(20_000),
    })
    const body = (await res.json().catch(() => ({}))) as { events_received?: number; error?: { message?: string } }
    const ok = res.ok && !body.error
    await db.agentMarketingEvent.updateMany({
      where: { eventId: { in: fresh.map((e) => e.eventId) } },
      data: { status: ok ? (opts?.testEventCode ? 'test' : 'sent') : 'failed', detail: ok ? null : body.error?.message?.slice(0, 300) },
    })
    return ok
      ? { ok: true, sent: fresh.length, deduped, eventsReceived: body.events_received }
      : { ok: false, sent: 0, deduped, error: body.error?.message ?? `HTTP ${res.status}` }
  } catch (err) {
    await db.agentMarketingEvent.updateMany({
      where: { eventId: { in: fresh.map((e) => e.eventId) } },
      data: { status: 'failed', detail: err instanceof Error ? err.message.slice(0, 300) : String(err) },
    })
    return { ok: false, sent: 0, deduped, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface CapiHealth {
  configured: boolean
  pixelId: string | null
  last7d: { recorded: number; sent: number; failed: number; deduped: number; test: number }
}

/** Diagnostics for the reconciliation dashboard — no secrets returned. */
export async function capiHealth(): Promise<CapiHealth> {
  const since = new Date(Date.now() - 7 * 86400000)
  const rows = await db.agentMarketingEvent.groupBy({
    by: ['status'],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
  }).catch(() => [])
  const byStatus: Record<string, number> = {}
  for (const r of rows as Array<{ status: string; _count: { _all: number } }>) byStatus[r.status] = r._count._all
  return {
    configured: capiConfigured(),
    pixelId: process.env.META_PIXEL_ID?.trim() || null,
    last7d: {
      recorded: Object.values(byStatus).reduce((s, n) => s + n, 0),
      sent: byStatus.sent ?? 0,
      failed: byStatus.failed ?? 0,
      deduped: byStatus.deduped ?? 0,
      test: byStatus.test ?? 0,
    },
  }
}
