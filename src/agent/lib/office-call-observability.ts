import { Prisma } from '@prisma/client'
import { createHmac } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { errorMeta, logEvent } from '@/lib/logger'

export const OFFICE_CALL_TIMING = {
  ringTimeoutMs: 60_000,
  peerReconnectGraceMs: 5_000,
  tokenTtlSec: 3_600,
  pushTtlSec: 45,
  maxCallDurationMs: 2 * 60 * 60_000,
} as const

export const OFFICE_CALL_PRODUCT_CONTRACT = {
  busyPolicy: 'reject_new_call',
  supportedClients: {
    ios: '17+',
    android: '7.0+ (API 24+)',
    web: 'current and previous major Chrome, Safari, Edge, Firefox',
  },
} as const

export const OFFICE_CALL_CLIENT_EVENTS = [
  'client.ring_received',
  'client.answer_pressed',
  'client.join_started',
  'client.local_joined',
  'client.peer_joined',
  'client.peer_left',
  'client.leave_started',
  'client.local_left',
  'client.media_error',
  'client.app_backgrounded',
  'client.app_foregrounded',
] as const

export type OfficeCallClientEvent = (typeof OFFICE_CALL_CLIENT_EVENTS)[number]
export type OfficeCallSource = 'server' | 'web' | 'ios' | 'android'
export type OfficeCallPlatform = 'web' | 'ios' | 'android'

const CLIENT_EVENT_SET = new Set<string>(OFFICE_CALL_CLIENT_EVENTS)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SENSITIVE_KEY_RE = /token|authorization|cookie|secret|certificate|private.?key|password|email|phone/i
const MAX_METADATA_KEYS = 24
const MAX_STRING_LENGTH = 180
const MAX_DEPTH = 3

export function isOfficeCallClientEvent(value: string): value is OfficeCallClientEvent {
  return CLIENT_EVENT_SET.has(value)
}

export function isOfficeCallId(value: string): boolean {
  return UUID_RE.test(value)
}

export function callIdFromAgoraChannel(channel: string): string | null {
  const candidate = channel.startsWith('itc_') ? channel.slice(4) : ''
  return isOfficeCallId(candidate) ? candidate : null
}

function cleanValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return value.slice(0, MAX_STRING_LENGTH)
  if (depth >= MAX_DEPTH) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => cleanValue(item, depth + 1))
  if (typeof value !== 'object') return String(value).slice(0, MAX_STRING_LENGTH)

  const result: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>).slice(0, MAX_METADATA_KEYS)) {
    result[key] = SENSITIVE_KEY_RE.test(key) ? '[redacted]' : cleanValue(nested, depth + 1)
  }
  return result
}

/** Keep diagnostic context bounded and remove secrets before it reaches logs/DB. */
export function sanitizeOfficeCallMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return cleanValue(value, 0) as Record<string, unknown>
}

type ProviderResult = { ok: boolean; status?: number; reason?: string }

/** Aggregate delivery evidence without persisting raw device tokens or response bodies. */
export function summarizeCallDelivery(results: ProviderResult[]) {
  const reasons: Record<string, number> = {}
  for (const result of results) {
    if (result.ok) continue
    const key = result.status ? `http_${result.status}` : canonicalReason(result.reason)
    reasons[key] = (reasons[key] ?? 0) + 1
  }
  const succeeded = results.filter((result) => result.ok).length
  return {
    attempted: results.length,
    succeeded,
    failed: results.length - succeeded,
    reasons,
  }
}

function canonicalReason(reason: string | undefined): string {
  if (!reason) return 'unknown'
  const value = reason.toLowerCase()
  if (value.includes('unconfigured')) return 'unconfigured'
  if (value.includes('unregistered')) return 'unregistered'
  if (value.includes('baddevicetoken')) return 'bad_device_token'
  if (value.includes('timeout')) return 'timeout'
  if (value.includes('auth')) return 'auth_failed'
  if (value.includes('connect')) return 'connect_failed'
  return 'provider_error'
}

export type RecordOfficeCallEventInput = {
  callId: string
  businessId: string
  event: string
  source: OfficeCallSource
  actorUserId?: string | null
  deviceId?: string | null
  platform?: OfficeCallPlatform | null
  appBuild?: string | null
  buildSha?: string | null
  state?: string | null
  provider?: string | null
  success?: boolean | null
  latencyMs?: number | null
  metadata?: unknown
  occurredAt?: Date
}

function pseudonymousDeviceId(value: string | null | undefined): string | null {
  const normalized = value?.trim()
  if (!normalized) return null
  const pepper = process.env.NEXTAUTH_SECRET || 'office-call-local-only'
  return createHmac('sha256', pepper).update(normalized.slice(0, 256)).digest('hex')
}

export async function recordOfficeCallEvent(input: RecordOfficeCallEventInput): Promise<void> {
  const metadata = sanitizeOfficeCallMetadata(input.metadata)
  await prisma.officeCallEvent.create({
    data: {
      callId: input.callId,
      businessId: input.businessId,
      event: input.event,
      source: input.source,
      actorUserId: input.actorUserId ?? null,
      // Raw IDFV / ANDROID_ID / browser UUID never enters logs or the database.
      deviceId: pseudonymousDeviceId(input.deviceId),
      platform: input.platform ?? null,
      appBuild: input.appBuild?.slice(0, 120) ?? null,
      buildSha: input.buildSha?.slice(0, 80) ?? null,
      state: input.state?.slice(0, 80) ?? null,
      provider: input.provider?.slice(0, 80) ?? null,
      success: input.success ?? null,
      latencyMs: input.latencyMs == null ? null : Math.max(0, Math.round(input.latencyMs)),
      metadata: metadata as Prisma.InputJsonValue | undefined,
      occurredAt: input.occurredAt,
    },
  })
  logEvent('info', `office_call.${input.event}`, {
    callId: input.callId,
    businessId: input.businessId,
    source: input.source,
    platform: input.platform,
    provider: input.provider,
    success: input.success,
    latencyMs: input.latencyMs,
    metadata,
  })
}

/** Observability may never break call placement, answering, or hangup. */
export async function safeRecordOfficeCallEvent(input: RecordOfficeCallEventInput): Promise<void> {
  try {
    await recordOfficeCallEvent(input)
  } catch (error) {
    logEvent('warn', 'office_call.observability_write_failed', {
      callId: input.callId,
      intendedEvent: input.event,
      ...errorMeta(error),
    })
  }
}
