import { createHash } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import { OFFICE_CALL_TIMING } from '@/agent/lib/office-call-observability'

type Env = Record<string, string | undefined>

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw)
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback
}

export type OfficeCallRuntimePolicy = {
  killSwitch: boolean
  rolloutPercent: number
  maxCallDurationMs: number
  rateLimit: {
    callerPerMinute: number
    callerPerTenMinutes: number
    pairPerTenMinutes: number
    eventsPerCallPerMinute: number
  }
  retention: { eventsDays: number; deliveryDays: number; sessionsDays: number; invalidDevicesDays: number }
}

export function getOfficeCallRuntimePolicy(env: Env = process.env): OfficeCallRuntimePolicy {
  return {
    killSwitch: env.OFFICE_CALLS_KILL_SWITCH === 'true',
    rolloutPercent: boundedInt(env.OFFICE_CALL_ROLLOUT_PERCENT, 100, 0, 100),
    maxCallDurationMs: boundedInt(env.OFFICE_CALL_MAX_DURATION_MINUTES, 120, 5, 240) * 60_000,
    rateLimit: {
      callerPerMinute: boundedInt(env.OFFICE_CALL_RATE_CALLER_PER_MINUTE, 4, 1, 30),
      callerPerTenMinutes: boundedInt(env.OFFICE_CALL_RATE_CALLER_PER_TEN_MINUTES, 20, 2, 100),
      pairPerTenMinutes: boundedInt(env.OFFICE_CALL_RATE_PAIR_PER_TEN_MINUTES, 8, 1, 50),
      eventsPerCallPerMinute: boundedInt(env.OFFICE_CALL_RATE_EVENTS_PER_MINUTE, 120, 30, 600),
    },
    retention: {
      eventsDays: boundedInt(env.OFFICE_CALL_EVENT_RETENTION_DAYS, 30, 7, 180),
      deliveryDays: boundedInt(env.OFFICE_CALL_DELIVERY_RETENTION_DAYS, 30, 7, 90),
      sessionsDays: boundedInt(env.OFFICE_CALL_SESSION_RETENTION_DAYS, 365, 30, 730),
      invalidDevicesDays: boundedInt(env.OFFICE_CALL_INVALID_DEVICE_RETENTION_DAYS, 90, 7, 365),
    },
  }
}

/** Stable canary assignment; changing rollout percentage never moves users between buckets. */
export function officeCallRolloutBucket(userId: string): number {
  const digest = createHash('sha256').update(`office-call-rollout:${userId}`).digest()
  return digest.readUInt32BE(0) % 100
}

export type OfficeCallPlacementDecision =
  | { ok: true }
  | { ok: false; error: 'calling_disabled' | 'rate_limited'; retryAfterSec?: number; limit?: string }

export function decideOfficeCallPlacement(args: {
  userId: string
  policy: OfficeCallRuntimePolicy
  callerLastMinute: number
  callerLastTenMinutes: number
  pairLastTenMinutes: number
}): OfficeCallPlacementDecision {
  if (args.policy.killSwitch || officeCallRolloutBucket(args.userId) >= args.policy.rolloutPercent) {
    return { ok: false, error: 'calling_disabled' }
  }
  if (args.callerLastMinute >= args.policy.rateLimit.callerPerMinute) {
    return { ok: false, error: 'rate_limited', retryAfterSec: 60, limit: 'caller_per_minute' }
  }
  if (args.callerLastTenMinutes >= args.policy.rateLimit.callerPerTenMinutes) {
    return { ok: false, error: 'rate_limited', retryAfterSec: 600, limit: 'caller_per_ten_minutes' }
  }
  if (args.pairLastTenMinutes >= args.policy.rateLimit.pairPerTenMinutes) {
    return { ok: false, error: 'rate_limited', retryAfterSec: 600, limit: 'pair_per_ten_minutes' }
  }
  return { ok: true }
}

/** Durable abuse preflight. Active-call locks remain the stronger concurrent-call invariant. */
export async function enforceOfficeCallPlacementPolicy(args: {
  businessId: string
  callerUserId: string
  calleeUserId: string
  now?: Date
}): Promise<OfficeCallPlacementDecision> {
  const policy = getOfficeCallRuntimePolicy()
  if (policy.killSwitch || officeCallRolloutBucket(args.callerUserId) >= policy.rolloutPercent) {
    return { ok: false, error: 'calling_disabled' }
  }
  const now = args.now ?? new Date()
  const minuteAgo = new Date(now.getTime() - 60_000)
  const tenMinutesAgo = new Date(now.getTime() - 10 * 60_000)
  const [callerLastMinute, callerLastTenMinutes, pairLastTenMinutes] = await Promise.all([
    prisma.officeCallSession.count({
      where: { businessId: args.businessId, callerUserId: args.callerUserId, createdAt: { gte: minuteAgo } },
    }),
    prisma.officeCallSession.count({
      where: { businessId: args.businessId, callerUserId: args.callerUserId, createdAt: { gte: tenMinutesAgo } },
    }),
    prisma.officeCallSession.count({
      where: {
        businessId: args.businessId,
        callerUserId: args.callerUserId,
        calleeUserId: args.calleeUserId,
        createdAt: { gte: tenMinutesAgo },
      },
    }),
  ])
  return decideOfficeCallPlacement({
    userId: args.callerUserId,
    policy,
    callerLastMinute,
    callerLastTenMinutes,
    pairLastTenMinutes,
  })
}

/** Bounded exponential reconnect schedule; clients still use canonical state as truth. */
export function officeCallReconnectBackoffMs(attempt: number, random = 0.5): number {
  const base = Math.min(8_000, 1_000 * 2 ** Math.max(0, Math.min(4, attempt - 1)))
  const jitter = Math.round(base * 0.2 * Math.min(1, Math.max(0, random)))
  return Math.min(OFFICE_CALL_TIMING.peerReconnectGraceMs, base + jitter)
}

type HealthSession = {
  id: string
  state: string
  terminalReason: string | null
  maxEndsAt: Date
  updatedAt: Date
  createdAt: Date
}

type HealthEvent = {
  callId: string
  event: string
  source: string
  platform: string | null
  appBuild: string | null
  success: boolean | null
  latencyMs: number | null
  metadata: unknown
  occurredAt: Date
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

function metadataNumber(metadata: unknown, key: string): number | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const value = Number((metadata as Record<string, unknown>)[key])
  return Number.isFinite(value) && value >= 0 ? value : null
}

function correlatedLatency(events: HealthEvent[], startEvent: string, endEvent: string): number[] {
  const byCall = new Map<string, HealthEvent[]>()
  for (const event of events) byCall.set(event.callId, [...(byCall.get(event.callId) ?? []), event])
  const values: number[] = []
  for (const rows of byCall.values()) {
    const start = rows.filter((row) => row.event === startEvent).sort((a, b) => +a.occurredAt - +b.occurredAt)[0]
    const end = rows.filter((row) => row.event === endEvent && (!start || row.occurredAt >= start.occurredAt))
      .sort((a, b) => +a.occurredAt - +b.occurredAt)[0]
    if (start && end) values.push(Math.max(0, +end.occurredAt - +start.occurredAt))
  }
  return values
}

export function buildOfficeCallHealthSnapshot(args: {
  sessions: HealthSession[]
  events: HealthEvent[]
  now?: Date
}) {
  const now = args.now ?? new Date()
  const terminal = args.sessions.filter((session) => session.state === 'ENDED')
  const failed = terminal.filter((session) => ['FAILED', 'PUSH_UNREACHABLE'].includes(session.terminalReason ?? ''))
  const missed = terminal.filter((session) => session.terminalReason === 'MISSED')
  const stuck = args.sessions.filter((session) => session.state !== 'ENDED' && session.maxEndsAt < now)
  const reconnects = args.events.filter((event) => event.event === 'client.reconnect_started')
  const pushAttempts = args.events.filter((event) => event.event === 'push.completed')
  const pushRejected = pushAttempts.filter((event) => event.success === false)
  const quality = args.events.filter((event) => event.event === 'client.quality_sample')
  const directPushToRing = args.events.filter((event) => event.event === 'client.ring_received' && event.latencyMs != null)
    .map((event) => event.latencyMs!)
  const joinLatency = [
    ...args.events.filter((event) => event.event === 'client.local_joined' && event.latencyMs != null).map((event) => event.latencyMs!),
    ...correlatedLatency(args.events, 'client.join_started', 'client.local_joined'),
  ]
  const answerToAudio = correlatedLatency(args.events, 'client.answer_pressed', 'client.peer_joined')
  const pushToRing = directPushToRing.length > 0
    ? directPushToRing
    : correlatedLatency(args.events, 'push.completed', 'client.ring_received')
  const alerts: string[] = []
  if (stuck.length > 0) alerts.push(`stuck_active_sessions:${stuck.length}`)
  if (pushAttempts.length >= 5 && pushRejected.length / pushAttempts.length > 0.2) alerts.push('push_rejection_spike')
  if (terminal.length >= 10 && missed.length / terminal.length > 0.3) alerts.push('excessive_miss_rate')
  if (terminal.length >= 5 && failed.length / terminal.length > 0.2) alerts.push('call_failure_regression')
  const worstLoss = Math.max(0, ...quality.map((event) => metadataNumber(event.metadata, 'packetLossPct') ?? 0))
  const worstRtt = Math.max(0, ...quality.map((event) => metadataNumber(event.metadata, 'rttMs') ?? 0))
  if (quality.length >= 5 && (worstLoss > 20 || worstRtt > 800)) alerts.push('media_quality_degraded')

  return {
    window: { calls: args.sessions.length, terminal: terminal.length },
    rates: {
      failure: terminal.length ? failed.length / terminal.length : 0,
      missed: terminal.length ? missed.length / terminal.length : 0,
      reconnectPerCall: args.sessions.length ? reconnects.length / args.sessions.length : 0,
      pushRejected: pushAttempts.length ? pushRejected.length / pushAttempts.length : 0,
    },
    latencyMs: {
      pushToRingP95: percentile(pushToRing, 0.95),
      joinP95: percentile(joinLatency, 0.95),
      answerToAudioP95: percentile(answerToAudio, 0.95),
    },
    media: { samples: quality.length, worstPacketLossPct: worstLoss, worstRttMs: worstRtt },
    stuckActiveSessions: stuck.length,
    alerts,
  }
}

export async function collectOfficeCallHealth(args: { businessId: string; now?: Date; hours?: number }) {
  const now = args.now ?? new Date()
  const since = new Date(now.getTime() - Math.min(168, Math.max(1, args.hours ?? 24)) * 60 * 60_000)
  const [sessions, events] = await Promise.all([
    prisma.officeCallSession.findMany({
      where: { businessId: args.businessId, createdAt: { gte: since } },
      select: { id: true, state: true, terminalReason: true, maxEndsAt: true, updatedAt: true, createdAt: true },
      take: 5_000,
    }),
    prisma.officeCallEvent.findMany({
      where: { businessId: args.businessId, occurredAt: { gte: since } },
      select: {
        callId: true, event: true, source: true, platform: true, appBuild: true,
        success: true, latencyMs: true, metadata: true, occurredAt: true,
      },
      take: 20_000,
    }),
  ])
  return buildOfficeCallHealthSnapshot({ sessions, events, now })
}

export async function monitorOfficeCallHealth(now = new Date()) {
  const businesses = await prisma.officeCallSession.groupBy({
    by: ['businessId'],
    where: { createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60_000) } },
  })
  const results = []
  for (const { businessId } of businesses) {
    const health = await collectOfficeCallHealth({ businessId, now })
    for (const alert of health.alerts) {
      logEvent('warn', 'office_call.health_alert', { businessId, alert, health })
    }
    results.push({ businessId, alerts: health.alerts })
  }
  return results
}

export async function purgeOfficeCallRetention(now = new Date()) {
  const { retention } = getOfficeCallRuntimePolicy()
  const cutoff = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60_000)
  const [events, outbox, invalidDevices, sessions] = await Promise.all([
    prisma.officeCallEvent.deleteMany({ where: { occurredAt: { lt: cutoff(retention.eventsDays) } } }),
    prisma.officeCallOutbox.deleteMany({
      where: { processedAt: { lt: cutoff(retention.deliveryDays) }, status: { in: ['DELIVERED', 'DEAD'] } },
    }),
    prisma.officeCallDevice.deleteMany({
      where: { active: false, invalidatedAt: { lt: cutoff(retention.invalidDevicesDays) } },
    }),
    prisma.officeCallSession.deleteMany({
      where: { state: 'ENDED', endedAt: { lt: cutoff(retention.sessionsDays) } },
    }),
  ])
  return { events: events.count, outbox: outbox.count, invalidDevices: invalidDevices.count, sessions: sessions.count }
}

export function officeCallMaintenanceSchedule(now = new Date()) {
  return {
    health: now.getUTCMinutes() % 5 === 0,
    retention: now.getUTCHours() === 2 && now.getUTCMinutes() === 0,
  }
}

export const OFFICE_CALL_MEDIA_SECURITY_POSTURE = {
  mediaProvider: 'Agora RTC',
  transportEncrypted: true,
  applicationMediaEncryptionEnabled: false,
  endToEndEncryptedClaimAllowed: false,
  userFacingClaim: 'Encrypted in transit. End-to-end encryption is not claimed.',
  blockingGap: 'Per-call key agreement, device verification, rotation and independent cryptographic review are not implemented.',
} as const
