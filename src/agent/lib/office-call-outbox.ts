import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { sendVoipCall, type ApnsVoipSendResult } from '@/agent/lib/apns-voip'
import { sendFcmCall, type FcmCallSendResult } from '@/agent/lib/fcm-call'
import { pushStaffDevice } from '@/agent/lib/office-notify'
import {
  getOfficeCallDeliveryDevices,
  invalidateOfficeCallDeviceToken,
} from '@/agent/lib/office-call-devices'
import { safeRecordOfficeCallEvent, summarizeCallDelivery } from '@/agent/lib/office-call-observability'
import { transitionCanonicalOfficeCall } from '@/agent/lib/office-call-domain'

const MAX_ATTEMPTS = 5
const LOCK_TIMEOUT_MS = 2 * 60_000

type OutboxPayload = {
  schemaVersion?: number
  event?: 'ring' | 'cancel'
  callId?: string
  callUUID?: string
  channel?: string
  callerName?: string
  expiresAt?: string
  reason?: string
}

function payloadRecord(value: Prisma.JsonValue): OutboxPayload {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as OutboxPayload : {}
}

function canonicalFailure(results: Array<ApnsVoipSendResult | FcmCallSendResult>) {
  if (results.length === 0) return 'no_eligible_device'
  const permanent = results.every((result) =>
    result.status === 400
    || result.status === 404
    || result.status === 410
    || /unconfigured|baddevicetoken|unregistered|invalidregistration/i.test(result.reason ?? ''),
  )
  return permanent ? 'provider_rejected_all' : 'provider_transient_failure'
}

function retryAt(attempts: number) {
  const seconds = Math.min(60, 2 ** Math.max(1, attempts))
  return new Date(Date.now() + seconds * 1000)
}

async function claimOne(now: Date) {
  return prisma.$transaction(async (tx) => {
    const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS)
    const candidate = await tx.officeCallOutbox.findFirst({
      where: {
        attempts: { lt: MAX_ATTEMPTS },
        availableAt: { lte: now },
        OR: [
          { status: { in: ['PENDING', 'FAILED'] } },
          { status: 'PROCESSING', lockedAt: { lt: staleBefore } },
        ],
      },
      orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
      include: { call: true },
    })
    if (!candidate) return null
    const claimed = await tx.officeCallOutbox.updateMany({
      where: {
        id: candidate.id,
        attempts: candidate.attempts,
        OR: [
          { status: { in: ['PENDING', 'FAILED'] } },
          { status: 'PROCESSING', lockedAt: { lt: staleBefore } },
        ],
      },
      data: { status: 'PROCESSING', lockedAt: now, attempts: { increment: 1 } },
    })
    return claimed.count === 1 ? { ...candidate, attempts: candidate.attempts + 1 } : null
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
}

async function recordProviderResults(args: {
  callId: string
  businessId: string
  provider: string
  startedAt: number
  results: Array<ApnsVoipSendResult | FcmCallSendResult>
}) {
  const summary = summarizeCallDelivery(args.results)
  const messageIds = args.results.flatMap((result) => result.messageId ? [result.messageId.slice(0, 180)] : [])
  await safeRecordOfficeCallEvent({
    callId: args.callId,
    businessId: args.businessId,
    source: 'server',
    event: 'push.completed',
    provider: args.provider,
    success: summary.succeeded > 0,
    latencyMs: Date.now() - args.startedAt,
    metadata: { ...summary, messageIds },
  })
}

async function dispatchRing(args: {
  callId: string
  businessId: string
  targetUserId: string
  payload: OutboxPayload
}) {
  const devices = await getOfficeCallDeliveryDevices({
    userId: args.targetUserId,
    businessId: args.businessId,
  })
  const results: Array<ApnsVoipSendResult | FcmCallSendResult> = []
  const common = {
    type: 'office_call' as const,
    schemaVersion: 1,
    broadcastId: args.callId,
    callId: args.callId,
    callUUID: args.payload.callUUID ?? args.callId,
    channel: args.payload.channel ?? `itc_${args.callId}`,
    caller: args.payload.callerName ?? 'অফিস কল',
    expiresAt: args.payload.expiresAt,
    event: 'ring' as const,
  }
  for (const environment of ['sandbox', 'production'] as const) {
    const tokens = devices
      .filter((device) => device.provider === 'apns_voip' && device.environment === environment)
      .map((device) => device.token)
    if (tokens.length === 0) continue
    const startedAt = Date.now()
    const sent = await sendVoipCall(tokens, common, { environment })
    results.push(...sent)
    await recordProviderResults({
      callId: args.callId,
      businessId: args.businessId,
      provider: `apns_voip_${environment}`,
      startedAt,
      results: sent,
    })
  }
  const fcmTokens = devices.filter((device) => device.provider === 'fcm').map((device) => device.token)
  if (fcmTokens.length > 0) {
    const startedAt = Date.now()
    const sent = await sendFcmCall(fcmTokens, common)
    results.push(...sent)
    await recordProviderResults({
      callId: args.callId,
      businessId: args.businessId,
      provider: 'fcm',
      startedAt,
      results: sent,
    })
  }
  for (const result of results) {
    if (result.ok) continue
    if (result.status === 410 || result.status === 404 || /unregistered|baddevicetoken/i.test(result.reason ?? '')) {
      const provider = devices.find((device) => device.token === result.token)?.provider
      if (provider) await invalidateOfficeCallDeviceToken(provider, result.token)
    }
  }
  return results
}

async function dispatchCancel(args: {
  callId: string
  businessId: string
  targetUserId: string
  payload: OutboxPayload
}) {
  const devices = await getOfficeCallDeliveryDevices({
    userId: args.targetUserId,
    businessId: args.businessId,
  })
  const fcmTokens = devices.filter((device) => device.provider === 'fcm').map((device) => device.token)
  const startedAt = Date.now()
  const fcm = fcmTokens.length > 0
    ? await sendFcmCall(fcmTokens, {
        type: 'office_call',
        schemaVersion: 1,
        broadcastId: args.callId,
        callId: args.callId,
        callUUID: args.payload.callUUID ?? args.callId,
        channel: args.payload.channel ?? `itc_${args.callId}`,
        caller: 'অফিস কল',
        event: 'cancel',
      })
    : []
  if (fcm.length > 0) {
    await recordProviderResults({
      callId: args.callId,
      businessId: args.businessId,
      provider: 'fcm',
      startedAt,
      results: fcm,
    })
  }
  // iOS cancellation deliberately uses the regular notification/live fetch
  // path. A VoIP push is only for a new incoming call and is never used here.
  const fallback = await pushStaffDevice(
    [args.targetUserId],
    '📞 কল শেষ',
    'কলের অবস্থা আপডেট হয়েছে।',
    {
      type: 'office_call_cancel',
      schemaVersion: 1,
      callId: args.callId,
      broadcastId: args.callId,
      reason: args.payload.reason ?? 'completed',
    },
    true,
  )
  return { results: fcm, fallbackOk: fallback.ok }
}

async function processClaimed(item: NonNullable<Awaited<ReturnType<typeof claimOne>>>) {
  const payload = payloadRecord(item.payload)
  const now = new Date()
  const expired = item.call.state !== 'ENDED'
    && (now >= item.call.ringExpiresAt || now >= item.call.maxEndsAt)
  if (item.kind === 'call.ring' && (item.call.state === 'ENDED' || expired)) {
    if (expired) {
      await transitionCanonicalOfficeCall({
        callId: item.callId,
        businessId: item.call.businessId,
        actorRole: 'server',
        target: 'ENDED',
        reason: 'MISSED',
        now,
      })
    }
    await prisma.officeCallOutbox.update({
      where: { id: item.id },
      data: { status: 'DELIVERED', processedAt: now, lockedAt: null, lastErrorCode: 'call_not_ringable' },
    })
    return 'skipped' as const
  }

  if (item.kind === 'call.cancel') {
    const delivered = await dispatchCancel({
      callId: item.callId,
      businessId: item.call.businessId,
      targetUserId: item.targetUserId,
      payload,
    })
    const ok = delivered.fallbackOk || delivered.results.some((result) => result.ok)
    await prisma.officeCallOutbox.update({
      where: { id: item.id },
      data: {
        status: ok ? 'DELIVERED' : item.attempts >= MAX_ATTEMPTS ? 'DEAD' : 'FAILED',
        processedAt: ok || item.attempts >= MAX_ATTEMPTS ? new Date() : null,
        availableAt: ok ? undefined : retryAt(item.attempts),
        lockedAt: null,
        lastErrorCode: ok ? null : 'cancel_delivery_failed',
      },
    })
    return ok ? 'delivered' as const : 'failed' as const
  }

  const results = await dispatchRing({
    callId: item.callId,
    businessId: item.call.businessId,
    targetUserId: item.targetUserId,
    payload,
  })
  if (results.length === 0) {
    await safeRecordOfficeCallEvent({
      callId: item.callId,
      businessId: item.call.businessId,
      source: 'server',
      event: 'push.completed',
      provider: 'none',
      success: false,
      metadata: { attempted: 0, succeeded: 0, failed: 0, reasons: { no_eligible_device: 1 } },
    })
  }
  const succeeded = results.some((result) => result.ok)
  const error = succeeded ? null : canonicalFailure(results)
  const dead = !succeeded && (item.attempts >= MAX_ATTEMPTS || error !== 'provider_transient_failure')
  await prisma.officeCallOutbox.update({
    where: { id: item.id },
    data: {
      status: succeeded ? 'DELIVERED' : dead ? 'DEAD' : 'FAILED',
      processedAt: succeeded || dead ? new Date() : null,
      availableAt: succeeded || dead ? undefined : retryAt(item.attempts),
      lockedAt: null,
      lastErrorCode: error,
    },
  })
  if (dead) {
    await transitionCanonicalOfficeCall({
      callId: item.callId,
      businessId: item.call.businessId,
      actorRole: 'server',
      target: 'ENDED',
      reason: 'PUSH_UNREACHABLE',
    })
  }
  return succeeded ? 'delivered' as const : dead ? 'dead' as const : 'failed' as const
}

export async function processOfficeCallOutbox(args: { limit?: number } = {}) {
  const limit = Math.min(50, Math.max(1, args.limit ?? 20))
  const summary = { claimed: 0, delivered: 0, failed: 0, dead: 0, skipped: 0 }
  for (let index = 0; index < limit; index += 1) {
    const item = await claimOne(new Date())
    if (!item) break
    summary.claimed += 1
    try {
      const outcome = await processClaimed(item)
      summary[outcome] += 1
    } catch (error) {
      const dead = item.attempts >= MAX_ATTEMPTS
      await prisma.officeCallOutbox.update({
        where: { id: item.id },
        data: {
          status: dead ? 'DEAD' : 'FAILED',
          processedAt: dead ? new Date() : null,
          availableAt: dead ? undefined : retryAt(item.attempts),
          lockedAt: null,
          lastErrorCode: error instanceof Error ? error.message.slice(0, 120) : 'dispatch_failed',
        },
      })
      summary[dead ? 'dead' : 'failed'] += 1
    }
  }
  return summary
}
