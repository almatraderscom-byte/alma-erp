import { prisma } from '@/lib/prisma'
import { normalizeSmsPhone } from '@/lib/sms/phone'
import { fetchSmsReport, sendSmsViaProvider, smsProviderConfigured } from '@/lib/sms/provider'
import type { QueueSmsInput, SmsStatus, SmsType } from '@/lib/sms/types'

const PROVIDER = 'sms.net.bd'
const MAX_ATTEMPTS = 1
const DEFAULT_COOLDOWN_MINUTES = 60
const MAX_BATCH = 10

const PERMANENT_ERROR_CODES = new Set(['400', '403', '405', '410', '412', '413', '414', '415', '416', '417', '420', '421'])
/** Only Alma Lifestyle order confirm + monthly salary wallet credit. */
const ACTIVE_SMS_TYPES = new Set<SmsType>(['ORDER_CONFIRMATION', 'SALARY_RECEIVED'])

export async function smsEnabledForBusiness(businessId?: string | null) {
  if (!smsProviderConfigured()) return false
  const id = businessId || 'GLOBAL'
  const setting = await prisma.smsSetting.findUnique({ where: { businessId: id } })
  if (setting) return setting.enabled
  return process.env.SMS_ENABLED === 'true'
}

export async function getQueueValidAfter(businessId?: string | null): Promise<Date | null> {
  const id = businessId || 'GLOBAL'
  const setting = await prisma.smsSetting.findUnique({
    where: { businessId: id },
    select: { queueValidAfter: true, enabled: true },
  })
  if (setting?.queueValidAfter) return setting.queueValidAfter
  const raw = String(process.env.SMS_QUEUE_VALID_AFTER || '').trim()
  if (raw) {
    const parsed = new Date(raw)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return null
}

function isLogEligibleForSend(row: { businessId: string | null; type: string; createdAt: Date }, validAfter: Date | null) {
  if (!ACTIVE_SMS_TYPES.has(row.type as SmsType)) return false
  if (!validAfter) return true
  return row.createdAt >= validAfter
}

/** Cancel pending SMS older than the recharge cutoff so they never send after top-up. */
export async function cancelStaleSmsQueue(businessId: string, validAfter: Date) {
  return prisma.smsLog.updateMany({
    where: {
      businessId,
      status: { in: ['QUEUED', 'PENDING', 'SENDING'] },
      createdAt: { lt: validAfter },
    },
    data: {
      status: 'FAILED',
      errorCode: 'CANCELLED',
      errorMessage: 'Skipped — SMS re-enabled after recharge; only new messages send from this point.',
      nextAttemptAt: null,
    },
  })
}

export async function markSmsEnabledForBusiness(
  businessId: string,
  enabled: boolean,
  updatedById?: string | null,
) {
  const now = new Date()
  const setting = await prisma.smsSetting.upsert({
    where: { businessId },
    create: {
      businessId,
      enabled,
      queueValidAfter: enabled ? now : null,
      updatedById: updatedById || null,
    },
    update: {
      enabled,
      updatedById: updatedById || null,
      ...(enabled ? { queueValidAfter: now } : {}),
    },
  })
  if (enabled) {
    await cancelStaleSmsQueue(businessId, now)
  }
  return setting
}

export async function queueSms(input: QueueSmsInput) {
  if (!ACTIVE_SMS_TYPES.has(input.type)) return { ok: false, skipped: true, reason: 'SMS_TYPE_DISABLED' }
  const phone = normalizeSmsPhone(input.phone)
  if (!phone) return { ok: false, skipped: true, reason: 'INVALID_PHONE' }
  const enabled = await smsEnabledForBusiness(input.businessId)
  if (!enabled) return { ok: false, skipped: true, reason: 'SMS_DISABLED' }

  const cooldownSince = new Date(Date.now() - (input.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES) * 60_000)
  const duplicate = await prisma.smsLog.findFirst({
    where: {
      businessId: input.businessId || null,
      phone,
      type: input.type,
      provider: PROVIDER,
      status: { in: ['QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'PENDING'] },
      createdAt: { gte: cooldownSince },
    },
    select: { id: true },
  })
  if (duplicate) return { ok: true, duplicate: true, id: duplicate.id }

  const log = await prisma.smsLog.create({
    data: {
      businessId: input.businessId || null,
      phone,
      message: input.message.slice(0, 918),
      type: input.type,
      provider: PROVIDER,
      status: 'QUEUED',
      metadataJson: input.metadata ? JSON.stringify(input.metadata).slice(0, 8000) : null,
    },
  })
  return { ok: true, id: log.id }
}

/** Queue SMS and send immediately — use from API routes that can await before responding. */
export async function flushQueuedSms(input: QueueSmsInput) {
  const result = await queueSms(input)
  if (result.ok && !result.duplicate) {
    await processSmsQueue({ limit: 1 })
  }
  return result
}

export function queueSmsAndFlush(input: QueueSmsInput) {
  void flushQueuedSms(input).catch(() => null)
}

export async function processSmsQueue(options: { limit?: number } = {}) {
  const now = new Date()
  const rows = await prisma.smsLog.findMany({
    where: {
      provider: PROVIDER,
      type: { in: Array.from(ACTIVE_SMS_TYPES) },
      status: { in: ['QUEUED', 'PENDING'] },
      attempts: { lt: MAX_ATTEMPTS },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { createdAt: 'asc' },
    take: Math.min(Math.max(options.limit || MAX_BATCH, 1), MAX_BATCH) * 3,
  })

  const results = []
  for (const row of rows) {
    if (results.length >= Math.min(Math.max(options.limit || MAX_BATCH, 1), MAX_BATCH)) break

    const validAfter = await getQueueValidAfter(row.businessId)
    if (!isLogEligibleForSend(row, validAfter)) {
      await prisma.smsLog.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          errorCode: 'CANCELLED',
          errorMessage: 'Skipped — created before SMS recharge cutoff.',
          nextAttemptAt: null,
        },
      })
      continue
    }

    const claimed = await prisma.smsLog.updateMany({
      where: { id: row.id, status: row.status },
      data: { status: 'SENDING', attempts: { increment: 1 }, updatedAt: new Date() },
    })
    if (!claimed.count) continue

    const result = await sendSmsViaProvider({ to: row.phone, message: row.message })
    if (result.ok) {
      results.push(await prisma.smsLog.update({
        where: { id: row.id },
        data: {
          status: 'SENT',
          requestId: result.requestId || row.requestId,
          errorCode: null,
          errorMessage: null,
          sentAt: new Date(),
          nextAttemptAt: result.requestId ? new Date(Date.now() + 15 * 60_000) : null,
        },
      }))
      continue
    }

    const nextAttempts = row.attempts + 1
    const permanent = result.errorCode ? PERMANENT_ERROR_CODES.has(result.errorCode) : false
    const shouldRetry = !permanent && nextAttempts < MAX_ATTEMPTS
    results.push(await prisma.smsLog.update({
      where: { id: row.id },
      data: {
        status: shouldRetry ? 'PENDING' : 'FAILED',
        errorCode: result.errorCode || 'UNKNOWN',
        errorMessage: result.errorMessage || 'SMS send failed',
        nextAttemptAt: shouldRetry ? nextRetryAt(nextAttempts) : null,
      },
    }))
  }
  return { ok: true, processed: results.length }
}

export async function refreshSmsDeliveryReports(limit = 20) {
  const rows = await prisma.smsLog.findMany({
    where: {
      provider: PROVIDER,
      requestId: { not: null },
      status: { in: ['SENT', 'PENDING'] },
    },
    orderBy: { sentAt: 'asc' },
    take: Math.min(Math.max(limit, 1), 50),
  })
  let checked = 0
  for (const row of rows) {
    if (!row.requestId) continue
    const report = await fetchSmsReport(row.requestId)
    checked += 1
    const status: SmsStatus = report.status === 'Sent' ? 'DELIVERED' : report.status === 'Failed' ? 'FAILED' : 'PENDING'
    await prisma.smsLog.update({
      where: { id: row.id },
      data: {
        status,
        errorCode: report.errorCode || null,
        errorMessage: report.errorMessage || null,
        deliveredAt: status === 'DELIVERED' ? new Date() : row.deliveredAt,
        nextAttemptAt: status === 'PENDING' ? new Date(Date.now() + 30 * 60_000) : null,
      },
    })
  }
  return { ok: true, checked }
}

export async function retrySmsLog(id: string) {
  const row = await prisma.smsLog.findUnique({ where: { id } })
  if (!row) return { ok: false, error: 'SMS log not found.' }
  if (!ACTIVE_SMS_TYPES.has(row.type as SmsType)) {
    return { ok: false, error: 'This SMS type is disabled.' }
  }
  const validAfter = await getQueueValidAfter(row.businessId)
  if (!isLogEligibleForSend(row, validAfter)) {
    return { ok: false, error: 'This SMS is from before the recharge cutoff and cannot be resent.' }
  }
  await prisma.smsLog.update({
    where: { id },
    data: {
      status: 'QUEUED',
      attempts: 0,
      errorCode: null,
      errorMessage: null,
      nextAttemptAt: null,
    },
  })
  return processSmsQueue({ limit: 1 })
}

export async function smsStats() {
  const [total, delivered, failed, queued] = await Promise.all([
    prisma.smsLog.count(),
    prisma.smsLog.count({ where: { status: 'DELIVERED' } }),
    prisma.smsLog.count({ where: { status: 'FAILED' } }),
    prisma.smsLog.count({ where: { status: { in: ['QUEUED', 'PENDING', 'SENDING', 'SENT'] } } }),
  ])
  return {
    total,
    delivered,
    failed,
    queued,
    successPct: total ? Math.round((delivered / total) * 100) : 0,
  }
}

export async function isSmsTypeEnabled(businessId: string | null | undefined, _type: SmsType) {
  if (!ACTIVE_SMS_TYPES.has(_type)) return false
  return smsEnabledForBusiness(businessId)
}

function nextRetryAt(attempts: number) {
  const minutes = attempts <= 1 ? 2 : attempts === 2 ? 10 : 30
  return new Date(Date.now() + minutes * 60_000)
}
