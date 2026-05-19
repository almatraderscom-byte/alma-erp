import type { TelegramNotificationQueue, TelegramNotificationStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { deliverTelegramNotificationRow } from '@/lib/telegram-notification/deliver'
import {
  eventTypeEnabled,
  getTelegramOpsSetting,
  normalizeOwnerChatIds,
  resolveOwnerChatIds,
} from '@/lib/telegram-notification/settings'
import type { EnqueueTelegramNotificationInput } from '@/lib/telegram-notification/types'

const MAX_BATCH = 15
const MAX_ATTEMPTS = 3
const RETRY_MINUTES = [1, 5, 15]

function nextRetryAt(attempts: number): Date {
  const mins = RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)] ?? 15
  return new Date(Date.now() + mins * 60_000)
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
    return { ok: false, skipped: 'TELEGRAM_BOT_TOKEN_MISSING' }
  }

  const setting = await getTelegramOpsSetting(input.businessId)
  if (!eventTypeEnabled(setting, input.eventType)) {
    return { ok: false, skipped: 'EVENT_DISABLED' }
  }

  const chatIds = normalizeOwnerChatIds(
    input.chatIds?.length ? input.chatIds : await resolveOwnerChatIds(input.businessId),
  )
  if (!chatIds.length) {
    console.warn('[telegram-queue] no recipients', {
      businessId: input.businessId,
      eventType: input.eventType,
    })
    return { ok: false, skipped: 'NO_OWNER_CHAT_IDS', recipientCount: 0 }
  }

  if (input.dedupeKey) {
    const existing = await prisma.telegramNotificationQueue.findUnique({
      where: { dedupeKey: input.dedupeKey },
      select: { id: true, status: true },
    })
    if (existing && ['QUEUED', 'SENDING', 'SENT'].includes(existing.status)) {
      return { ok: true, duplicate: true, ids: [existing.id], recipientCount: chatIds.length }
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

  console.info('[telegram-queue] enqueued', {
    businessId: input.businessId,
    eventType: input.eventType,
    recipientCount: chatIds.length,
    rowCount: ids.length,
  })

  return { ok: true, ids, recipientCount: chatIds.length }
}

/** Reliable flush — await this after critical alerts (e.g. screenshot upload). */
export async function flushTelegramNotificationQueue(options: { limit?: number; ids?: string[] } = {}) {
  return processTelegramNotificationQueue(options)
}

export function enqueueTelegramNotificationAndFlush(input: EnqueueTelegramNotificationInput) {
  void enqueueTelegramNotification(input)
    .then(async result => {
      if (result.ok && result.ids?.length && !result.duplicate) {
        await processTelegramNotificationQueue({ limit: result.ids.length, ids: result.ids })
      } else if (result.skipped) {
        console.warn('[telegram-queue] skip async flush', result.skipped, input.eventType)
      }
    })
    .catch(err => {
      console.error('[telegram-queue] async flush error', (err as Error).message)
    })
}

export async function processTelegramNotificationQueue(options: { limit?: number; ids?: string[] } = {}) {
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

    const claimed = await prisma.telegramNotificationQueue.updateMany({
      where: { id: row.id, status: { in: ['QUEUED', 'FAILED'] } },
      data: { status: 'SENDING', attempts: { increment: 1 }, updatedAt: new Date() },
    })
    if (!claimed.count) continue

    const send = await deliverTelegramNotificationRow(row)
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
      results.push({ id: updated.id, status: updated.status })
      continue
    }

    const fresh = await prisma.telegramNotificationQueue.findUnique({ where: { id: row.id } })
    const attempts = fresh?.attempts ?? row.attempts + 1
    const failed = attempts >= MAX_ATTEMPTS
    const updated = await prisma.telegramNotificationQueue.update({
      where: { id: row.id },
      data: {
        status: failed ? 'FAILED' : 'QUEUED',
        errorMessage: send.errorMessage?.slice(0, 500) || 'delivery_failed',
        nextAttemptAt: failed ? null : nextRetryAt(attempts),
      },
    })
    results.push({ id: updated.id, status: updated.status, errorMessage: updated.errorMessage })
  }

  return { processed: results.length, results }
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
