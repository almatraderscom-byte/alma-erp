import type { TelegramNotificationQueue, TelegramNotificationStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { deliverTelegramNotificationRow } from '@/lib/telegram-notification/deliver'
import { isTelegramDeliveryRetryable } from '@/lib/telegram-notification/delivery-policy'
import { resolveOwnerChatIdsWithMeta } from '@/lib/telegram-notification/owner-routing'
import { eventTypeEnabled, getTelegramOpsSetting } from '@/lib/telegram-notification/settings'
import { logTelegram } from '@/lib/telegram-notification/telegram-log'
import type { EnqueueTelegramNotificationInput } from '@/lib/telegram-notification/types'
import {
  ABSENT_DELIVERY_MIN_AGE_MS,
  absentDeliveryAgeOk,
  verifyAbsentBeforeTelegramAlert,
} from '@/lib/attendance-absent-safety'
import { logEvent } from '@/lib/logger'

const MAX_BATCH = 15
const MAX_ATTEMPTS = 3
const RETRY_MINUTES = [1, 5, 15]
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
        },
      })
      ids.push(row.id)
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'P2002' && dedupeKey) continue
      throw e
    }
  }

  logTelegram('info', 'telegram.enqueue.queued', {
    businessId: input.businessId,
    eventType: input.eventType,
    rowCount: ids.length,
    routingSource: routing.source,
  })

  return { ok: true, ids, recipientCount: chatIds.length }
}

/** Reliable flush — await this after critical alerts (e.g. screenshot upload). */
export async function flushTelegramNotificationQueue(options: { limit?: number; ids?: string[] } = {}) {
  return processTelegramNotificationQueue(options)
}

export async function enqueueTelegramNotificationAndFlush(input: EnqueueTelegramNotificationInput) {
  const result = await enqueueTelegramNotification(input)
  if (!result.ok) {
    if (result.skipped) {
      logTelegram('warn', 'telegram.flush.skipped', { reason: result.skipped, eventType: input.eventType })
    }
    return result
  }

  const ids = result.ids
  if (!ids?.length) return result

  const delivered = await processTelegramNotificationQueue({ limit: ids.length, ids })
  return { ...result, delivered }
}

/** Fire-and-forget wrapper — prefer await enqueueTelegramNotificationAndFlush in API routes. */
export function scheduleTelegramNotificationAndFlush(input: EnqueueTelegramNotificationInput) {
  void enqueueTelegramNotificationAndFlush(input).catch(err => {
    logTelegram('error', 'telegram.flush.async_error', {
      eventType: input.eventType,
      message: (err as Error).message,
    })
  })
}

export async function processTelegramNotificationQueue(options: { limit?: number; ids?: string[] } = {}) {
  await reclaimStuckTelegramSendingRows()

  const now = new Date()
  const take = Math.min(Math.max(options.limit ?? MAX_BATCH, 1), MAX_BATCH)

  const rows = options.ids?.length
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
        take,
      })

  const results: Array<{ id: string; status: TelegramNotificationStatus; errorMessage?: string | null }> = []

  for (const row of rows) {
    if (row.status === 'SENT') {
      results.push({ id: row.id, status: row.status })
      continue
    }
    if (row.attempts >= MAX_ATTEMPTS && row.status === 'FAILED' && !options.ids?.includes(row.id)) {
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

    const claimed = await prisma.telegramNotificationQueue.updateMany({
      where: { id: row.id, status: { in: ['QUEUED', 'FAILED'] } },
      data: { status: 'SENDING', attempts: { increment: 1 }, updatedAt: new Date() },
    })
    if (!claimed.count) continue

    const started = Date.now()
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
        },
      })
      logTelegram('info', 'telegram.send.success', {
        id: row.id,
        eventType: row.eventType,
        chatId: row.chatId,
        latencyMs: Date.now() - started,
        attempts: updated.attempts,
      })
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
    const retryable = isTelegramDeliveryRetryable(send.errorMessage, send.errorCode)
    const exhausted = attempts >= MAX_ATTEMPTS
    const failed = !retryable || exhausted
    const updated = await prisma.telegramNotificationQueue.update({
      where: { id: row.id },
      data: {
        status: failed ? 'FAILED' : 'QUEUED',
        errorMessage: send.errorMessage?.slice(0, 500) || 'delivery_failed',
        nextAttemptAt: failed ? null : nextRetryAt(attempts),
      },
    })
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

export async function getTelegramQueueHealth() {
  const cutoff = stuckSendingCutoff()
  const [byStatus, stuckSending, oldestQueued] = await Promise.all([
    prisma.telegramNotificationQueue.groupBy({
      by: ['status'],
      _count: { _all: true },
    }),
    prisma.telegramNotificationQueue.count({
      where: { status: 'SENDING', updatedAt: { lt: cutoff } },
    }),
    prisma.telegramNotificationQueue.findFirst({
      where: { status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, createdAt: true, eventType: true },
    }),
  ])
  return {
    byStatus: byStatus.map(s => ({ status: s.status, count: s._count._all })),
    stuckSending,
    oldestQueued: oldestQueued
      ? { id: oldestQueued.id, eventType: oldestQueued.eventType, ageMinutes: Math.round((Date.now() - oldestQueued.createdAt.getTime()) / 60_000) }
      : null,
    botTokenConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
    cronSecretConfigured: Boolean(process.env.CRON_SECRET?.trim()),
    ownerChatIdsEnv: Boolean(process.env.TELEGRAM_OWNER_CHAT_IDS?.trim()),
  }
}
