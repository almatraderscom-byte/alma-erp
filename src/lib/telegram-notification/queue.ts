import type { TelegramNotificationQueue, TelegramNotificationStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { deliverTelegramNotificationRow } from '@/lib/telegram-notification/deliver'
import { isTelegramDeliveryRetryable } from '@/lib/telegram-notification/delivery-policy'
import { resolveOwnerChatIdsWithMeta } from '@/lib/telegram-notification/owner-routing'
import {
  compareTelegramQueueRows,
  lowPriorityInitialDelay,
  telegramEventPriority,
} from '@/lib/telegram-notification/priority'
import { eventTypeEnabled, getTelegramOpsSetting } from '@/lib/telegram-notification/settings'
import { logTelegram } from '@/lib/telegram-notification/telegram-log'
import type { EnqueueTelegramNotificationInput } from '@/lib/telegram-notification/types'
import {
  ABSENT_DELIVERY_MIN_AGE_MS,
  absentDeliveryAgeOk,
  verifyAbsentBeforeTelegramAlert,
} from '@/lib/attendance-absent-safety'
import { logEvent } from '@/lib/logger'

const MAX_BATCH = 20
const MAX_ATTEMPTS = 4
const RETRY_MINUTES = [1, 5, 15, 60]
/** Serverless may die after claiming SENDING — reclaim rows older than this. */
export const STUCK_SENDING_MS = 2 * 60_000

function nextRetryAt(attempts: number): Date {
  const mins = RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)] ?? 15
  return new Date(Date.now() + mins * 60_000)
}

function stuckSendingCutoff() {
  return new Date(Date.now() - STUCK_SENDING_MS)
}

/** Reset rows left in SENDING after a crashed/timed-out serverless invocation. */
export async function reclaimStuckTelegramSendingRows(): Promise<number> {
  const cutoff = stuckSendingCutoff()
  const reclaimed = await prisma.telegramNotificationQueue.updateMany({
    where: { status: 'SENDING', updatedAt: { lt: cutoff } },
    data: {
      status: 'QUEUED',
      errorMessage: 'reclaimed_from_stuck_sending',
      nextAttemptAt: null,
    },
  })
  if (reclaimed.count > 0) {
    logTelegram('warn', 'telegram.queue.reclaimed_stuck', { count: reclaimed.count })
  }
  return reclaimed.count
}

export async function enqueueTelegramNotification(
  input: EnqueueTelegramNotificationInput,
): Promise<{
  ok: boolean
  skipped?: string
  ids?: string[]
  duplicate?: boolean
  recipientCount?: number
}> {
  if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
    logTelegram('warn', 'telegram.enqueue.skipped', { reason: 'TELEGRAM_BOT_TOKEN_MISSING', eventType: input.eventType })
    return { ok: false, skipped: 'TELEGRAM_BOT_TOKEN_MISSING' }
  }

  const setting = await getTelegramOpsSetting(input.businessId)
  const forceEnqueue = Boolean((input.metadata as { force?: boolean } | undefined)?.force)
  if (!forceEnqueue && !eventTypeEnabled(setting, input.eventType)) {
    logTelegram('warn', 'telegram.enqueue.skipped', { reason: 'EVENT_DISABLED', eventType: input.eventType, businessId: input.businessId })
    return { ok: false, skipped: 'EVENT_DISABLED' }
  }

  const routing = input.chatIds?.length
    ? {
        chatIds: input.chatIds,
        source: 'explicit' as const,
        dbIds: [] as string[],
        envIds: [] as string[],
        invalidDbTokens: [] as string[],
        invalidEnvTokens: [] as string[],
      }
    : await resolveOwnerChatIdsWithMeta(input.businessId)
  const chatIds = routing.chatIds
  if (!chatIds.length) {
    logTelegram('warn', 'telegram.enqueue.skipped', {
      reason: 'NO_OWNER_CHAT_IDS',
      businessId: input.businessId,
      eventType: input.eventType,
      routingSource: routing.source,
    })
    return { ok: false, skipped: 'NO_OWNER_CHAT_IDS', recipientCount: 0 }
  }

  if (input.dedupeKey) {
    const existing = await prisma.telegramNotificationQueue.findUnique({
      where: { dedupeKey: input.dedupeKey },
    })
    if (existing) {
      if (existing.status === 'SENT') {
        return { ok: true, duplicate: true, ids: [existing.id], recipientCount: chatIds.length }
      }
      if (existing.status === 'SENDING' && existing.updatedAt < stuckSendingCutoff()) {
        await prisma.telegramNotificationQueue.update({
          where: { id: existing.id },
          data: {
            status: 'QUEUED',
            errorMessage: 'reclaimed_stuck_sending',
            nextAttemptAt: null,
          },
        })
        logTelegram('warn', 'telegram.enqueue.reclaim_dedupe', {
          id: existing.id,
          dedupeKey: input.dedupeKey,
          eventType: input.eventType,
        })
        return { ok: true, ids: [existing.id], recipientCount: chatIds.length }
      }
      if (existing.status === 'FAILED') {
        await prisma.telegramNotificationQueue.update({
          where: { id: existing.id },
          data: {
            status: 'QUEUED',
            message: input.message.slice(0, 4000),
            metadataJson: input.metadata ? JSON.stringify(input.metadata).slice(0, 8000) : existing.metadataJson,
            errorMessage: null,
            nextAttemptAt: null,
          },
        })
        return { ok: true, ids: [existing.id], recipientCount: chatIds.length }
      }
      if (['QUEUED', 'SENDING'].includes(existing.status)) {
        return { ok: true, duplicate: true, ids: [existing.id], recipientCount: chatIds.length }
      }
    }
  }

  const metadataJson = input.metadata ? JSON.stringify(input.metadata).slice(0, 8000) : null
  const ids: string[] = []

  const initialDelay = lowPriorityInitialDelay(input.eventType)

  for (const chatId of chatIds) {
    const dedupeKey =
      chatIds.length === 1 ? input.dedupeKey : input.dedupeKey ? `${input.dedupeKey}:${chatId}` : null
    try {
      const row = await prisma.telegramNotificationQueue.create({
        data: {
          businessId: input.businessId,
          chatId,
          eventType: input.eventType,
          dedupeKey,
          message: input.message.slice(0, 4000),
          status: 'QUEUED',
          metadataJson,
          maxAttempts: MAX_ATTEMPTS,
          nextAttemptAt: initialDelay,
        },
      })
      ids.push(row.id)
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'P2002' && dedupeKey) continue
      throw e
    }
  }

  const priority = telegramEventPriority(input.eventType)
  logTelegram('info', 'telegram.enqueue', {
    businessId: input.businessId,
    eventType: input.eventType,
    rowCount: ids.length,
    routingSource: routing.source,
    priority,
  })
  logEvent('info', 'notification.telegram.queued', {
    businessId: input.businessId,
    eventType: input.eventType,
    rowCount: ids.length,
  })

  return { ok: true, ids, recipientCount: chatIds.length }
}

/**
 * Persist a Telegram queue row. AWAITS the DB INSERT so it lands even if the
 * surrounding serverless invocation terminates immediately after the response.
 * Never throws — failures are logged. Telegram API delivery still happens in
 * background (cron / explicit processor), so callers may safely `await` this
 * inside request handlers without blocking on Telegram itself.
 */
export async function scheduleTelegramNotification(
  input: EnqueueTelegramNotificationInput,
): Promise<{ ok: boolean; ids?: string[]; skipped?: string; duplicate?: boolean }> {
  try {
    const result = await enqueueTelegramNotification(input)
    return result
  } catch (err) {
    logTelegram('error', 'telegram.enqueue.async_error', {
      eventType: input.eventType,
      message: (err as Error).message,
    })
    logEvent('error', 'telegram.queue.enqueue_failed', {
      eventType: input.eventType,
      businessId: input.businessId,
      message: (err as Error).message,
    })
    return { ok: false, skipped: 'ENQUEUE_EXCEPTION' }
  }
}

/** @deprecated Use scheduleTelegramNotification — flush removed from ERP hot paths. */
export async function scheduleTelegramNotificationAndFlush(input: EnqueueTelegramNotificationInput) {
  return scheduleTelegramNotification(input)
}

/** Explicit processor invoke (cron, admin "Process queue", tests). */
export async function flushTelegramNotificationQueue(options: { limit?: number; ids?: string[] } = {}) {
  return processTelegramNotificationQueue(options)
}

/** Admin/cron only — enqueue then process in same invocation. */
export async function enqueueTelegramNotificationAndFlush(input: EnqueueTelegramNotificationInput) {
  const result = await enqueueTelegramNotification(input)
  if (!result.ok || !result.ids?.length) return result
  const delivered = await processTelegramNotificationQueue({ limit: result.ids.length, ids: result.ids })
  return { ...result, delivered }
}

export async function processTelegramNotificationQueue(options: { limit?: number; ids?: string[] } = {}) {
  await reclaimStuckTelegramSendingRows()

  const now = new Date()
  const take = Math.min(Math.max(options.limit ?? MAX_BATCH, 1), MAX_BATCH)

  const rowsRaw = options.ids?.length
    ? await prisma.telegramNotificationQueue.findMany({
        where: { id: { in: options.ids } },
        orderBy: { createdAt: 'asc' },
      })
    : await prisma.telegramNotificationQueue.findMany({
        where: {
          status: { in: ['QUEUED', 'FAILED'] },
          attempts: { lt: MAX_ATTEMPTS },
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        orderBy: { createdAt: 'asc' },
        take: take * 2,
      })

  const rows = [...rowsRaw].sort(compareTelegramQueueRows).slice(0, take)

  logTelegram('info', 'telegram.process.start', {
    batch: rows.length,
    explicitIds: Boolean(options.ids?.length),
  })

  const results: Array<{ id: string; status: TelegramNotificationStatus; errorMessage?: string | null }> = []

  for (const row of rows) {
    if (row.status === 'SENT') {
      results.push({ id: row.id, status: row.status })
      continue
    }
    const rowMax = row.maxAttempts ?? MAX_ATTEMPTS
    if (row.attempts >= rowMax && row.status === 'FAILED' && !options.ids?.includes(row.id)) {
      continue
    }

    if (row.eventType === 'ATTENDANCE_ABSENT') {
      let employeeId: string | undefined
      try {
        const meta = row.metadataJson ? (JSON.parse(row.metadataJson) as { employeeId?: string }) : {}
        employeeId = meta.employeeId
      } catch {
        employeeId = undefined
      }

      if (!absentDeliveryAgeOk(row.createdAt)) {
        await prisma.telegramNotificationQueue.updateMany({
          where: { id: row.id, status: { in: ['QUEUED', 'FAILED'] } },
          data: {
            errorMessage: 'absent_delivery_grace_wait',
            nextAttemptAt: new Date(row.createdAt.getTime() + ABSENT_DELIVERY_MIN_AGE_MS),
          },
        })
        results.push({ id: row.id, status: 'QUEUED', errorMessage: 'absent_delivery_grace_wait' })
        continue
      }

      if (employeeId) {
        const verification = await verifyAbsentBeforeTelegramAlert({
          businessId: row.businessId,
          employeeId,
        })
        if (!verification.allow) {
          await prisma.telegramNotificationQueue.updateMany({
            where: { id: row.id, status: { in: ['QUEUED', 'FAILED', 'SENDING'] } },
            data: {
              status: 'SKIPPED',
              errorMessage: `false_positive_blocked:${verification.reason}`,
              nextAttemptAt: null,
            },
          })
          logEvent('info', 'attendance.false_positive_blocked', {
            businessId: row.businessId,
            employeeId,
            reason: verification.reason,
            phase: 'pre_delivery',
            queueId: row.id,
          })
          results.push({ id: row.id, status: 'SKIPPED', errorMessage: verification.reason })
          continue
        }
      }
    }

    const claimAt = new Date()
    const claimed = await prisma.telegramNotificationQueue.updateMany({
      where: { id: row.id, status: { in: ['QUEUED', 'FAILED'] } },
      data: {
        status: 'SENDING',
        attempts: { increment: 1 },
        processingStartedAt: claimAt,
        updatedAt: claimAt,
      },
    })
    if (!claimed.count) continue

    const started = Date.now()
    logTelegram('info', 'telegram.process.job', {
      queueJobId: row.id,
      eventType: row.eventType,
      businessId: row.businessId,
      priority: telegramEventPriority(row.eventType),
      attempt: row.attempts + 1,
    })
    let send: Awaited<ReturnType<typeof deliverTelegramNotificationRow>>
    try {
      send = await deliverTelegramNotificationRow(row)
    } catch (e) {
      send = { ok: false, errorMessage: (e as Error).message || 'delivery_exception' }
      logTelegram('error', 'telegram.send.exception', {
        id: row.id,
        eventType: row.eventType,
        chatId: row.chatId,
        message: (e as Error).message,
      })
    }

    if (send.ok) {
      const updated = await prisma.telegramNotificationQueue.update({
        where: { id: row.id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          errorMessage: null,
          nextAttemptAt: null,
          processingStartedAt: null,
        },
      })
      logTelegram('info', 'telegram.send.success', {
        id: row.id,
        eventType: row.eventType,
        chatId: row.chatId,
        latencyMs: Date.now() - started,
        attempts: updated.attempts,
      })
      logEvent('info', 'notification.telegram.sent', {
        id: row.id,
        eventType: row.eventType,
        businessId: row.businessId,
        latencyMs: Date.now() - started,
      })
      if (row.eventType === 'ATTENDANCE_FACE_VERIFIED_CHECK_IN') {
        logEvent('info', 'attendance.telegram.sent', {
          id: row.id,
          businessId: row.businessId,
          latencyMs: Date.now() - started,
        })
      }
      if (row.eventType === 'ATTENDANCE_ABSENT') {
        let employeeId: string | undefined
        try {
          const meta = row.metadataJson ? (JSON.parse(row.metadataJson) as { employeeId?: string }) : {}
          employeeId = meta.employeeId
        } catch {
          employeeId = undefined
        }
        logEvent('info', 'attendance.telegram.sent', {
          businessId: row.businessId,
          employeeId,
          queueId: row.id,
          latencyMs: Date.now() - started,
        })
      }
      results.push({ id: updated.id, status: updated.status })
      continue
    }

    const fresh = await prisma.telegramNotificationQueue.findUnique({ where: { id: row.id } })
    const attempts = fresh?.attempts ?? row.attempts + 1
    const maxAttempts = fresh?.maxAttempts ?? row.maxAttempts ?? MAX_ATTEMPTS
    const retryable = isTelegramDeliveryRetryable(send.errorMessage, send.errorCode)
    const exhausted = attempts >= maxAttempts
    const failed = !retryable || exhausted
    const updated = await prisma.telegramNotificationQueue.update({
      where: { id: row.id },
      data: {
        status: failed ? 'FAILED' : 'QUEUED',
        errorMessage: send.errorMessage?.slice(0, 500) || 'delivery_failed',
        nextAttemptAt: failed ? null : nextRetryAt(attempts),
        processingStartedAt: null,
      },
    })
    if (!failed) {
      logTelegram('warn', 'telegram.retry', {
        queueJobId: row.id,
        eventType: row.eventType,
        attempts,
        nextAttemptAt: updated.nextAttemptAt?.toISOString(),
        error: updated.errorMessage,
      })
      if (row.eventType === 'ATTENDANCE_FACE_VERIFIED_CHECK_IN') {
        logEvent('warn', 'attendance.telegram.retry', {
          id: row.id,
          businessId: row.businessId,
          attempts,
          error: updated.errorMessage,
        })
      }
    }
    const failureEvent = failed ? 'telegram.send.failed' : 'telegram.retry'
    logTelegram(failed ? 'error' : 'warn', failureEvent, {
      id: row.id,
      eventType: row.eventType,
      chatId: row.chatId,
      latencyMs: Date.now() - started,
      attempts,
      retryable: !failed,
      failureClass: retryable ? 'retryable' : 'permanent',
      error: updated.errorMessage,
      errorCode: send.errorCode,
      nextAttemptAt: updated.nextAttemptAt?.toISOString() ?? null,
    })
    if (failed && row.eventType === 'ATTENDANCE_FACE_VERIFIED_CHECK_IN') {
      logEvent(failed && attempts >= maxAttempts ? 'error' : 'warn', 'attendance.telegram.failed', {
        id: row.id,
        businessId: row.businessId,
        attempts,
        error: updated.errorMessage,
        deadLetter: attempts >= maxAttempts,
      })
      if (attempts >= maxAttempts) {
        logEvent('error', 'attendance.telegram.dead_letter', {
          id: row.id,
          businessId: row.businessId,
          eventType: row.eventType,
        })
      }
    }
    results.push({ id: updated.id, status: updated.status, errorMessage: updated.errorMessage })
  }

  const stuck = await prisma.telegramNotificationQueue.count({
    where: { status: 'SENDING', updatedAt: { lt: stuckSendingCutoff() } },
  })
  if (stuck > 0) {
    logTelegram('warn', 'telegram.queue.stuck', { count: stuck })
  }

  return { processed: results.length, results, stuckSending: stuck }
}

export async function retryAllFailedTelegramNotifications(businessId?: string, limit = 40) {
  const rows = await prisma.telegramNotificationQueue.findMany({
    where: {
      status: 'FAILED',
      ...(businessId ? { businessId } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: { id: true },
  })
  let requeued = 0
  for (const row of rows) {
    await prisma.telegramNotificationQueue.update({
      where: { id: row.id },
      data: {
        status: 'QUEUED',
        attempts: 0,
        nextAttemptAt: null,
        errorMessage: null,
        processingStartedAt: null,
      },
    })
    requeued += 1
  }
  const processed = requeued ? await processTelegramNotificationQueue({ limit: Math.min(requeued, MAX_BATCH) }) : { processed: 0, results: [] }
  return { requeued, processed }
}

export async function retryTelegramNotification(id: string) {
  const row = await prisma.telegramNotificationQueue.findUnique({ where: { id } })
  if (!row) return { ok: false, error: 'NOT_FOUND' }
  await prisma.telegramNotificationQueue.update({
    where: { id },
    data: {
      status: 'QUEUED',
      nextAttemptAt: null,
      errorMessage: null,
    },
  })
  return processTelegramNotificationQueue({ ids: [id], limit: 1 })
}

export async function getTelegramQueueHealth(businessId?: string) {
  const cutoff = stuckSendingCutoff()
  const businessWhere = businessId ? { businessId } : {}
  const [byStatus, stuckSending, oldestQueued, processingCount, retryWaitCount, avgLatency] = await Promise.all([
    prisma.telegramNotificationQueue.groupBy({
      by: ['status'],
      where: businessWhere,
      _count: { _all: true },
    }),
    prisma.telegramNotificationQueue.count({
      where: { status: 'SENDING', updatedAt: { lt: cutoff }, ...businessWhere },
    }),
    prisma.telegramNotificationQueue.findFirst({
      where: { status: 'QUEUED', ...businessWhere },
      orderBy: { createdAt: 'asc' },
      select: { id: true, createdAt: true, eventType: true },
    }),
    prisma.telegramNotificationQueue.count({
      where: { status: 'SENDING', ...businessWhere },
    }),
    prisma.telegramNotificationQueue.count({
      where: {
        status: 'QUEUED',
        attempts: { gt: 0 },
        nextAttemptAt: { not: null },
        ...businessWhere,
      },
    }),
    prisma.telegramNotificationQueue.findMany({
      where: {
        status: 'SENT',
        sentAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) },
        processingStartedAt: { not: null },
        ...businessWhere,
      },
      select: { createdAt: true, sentAt: true, processingStartedAt: true },
      take: 200,
      orderBy: { sentAt: 'desc' },
    }),
  ])

  const latencySamples = avgLatency
    .map(r => {
      if (!r.sentAt || !r.processingStartedAt) return null
      return r.sentAt.getTime() - r.processingStartedAt.getTime()
    })
    .filter((n): n is number => n != null && n >= 0)
  const averageDeliveryLatencyMs = latencySamples.length
    ? Math.round(latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length)
    : null

  const pendingDepth =
    (byStatus.find(s => s.status === 'QUEUED')?._count._all ?? 0)
    + (byStatus.find(s => s.status === 'FAILED')?._count._all ?? 0)

  return {
    byStatus: byStatus.map(s => ({ status: s.status, count: s._count._all })),
    stuckSending,
    processingCount,
    retryWaitCount,
    pendingDepth,
    averageDeliveryLatencyMs,
    oldestQueued: oldestQueued
      ? { id: oldestQueued.id, eventType: oldestQueued.eventType, ageMinutes: Math.round((Date.now() - oldestQueued.createdAt.getTime()) / 60_000) }
      : null,
    botTokenConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
    cronSecretConfigured: Boolean(process.env.CRON_SECRET?.trim()),
    ownerChatIdsEnv: Boolean(process.env.TELEGRAM_OWNER_CHAT_IDS?.trim()),
  }
}
