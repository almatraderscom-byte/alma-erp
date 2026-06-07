import { prisma } from '@/lib/prisma'
import { normalizeSmsPhone } from '@/lib/sms/phone'
import { fetchSmsReport, sendSmsViaProvider, smsProviderConfigured } from '@/lib/sms/provider'
import type { QueueSmsInput, SmsStatus, SmsType } from '@/lib/sms/types'

const PROVIDER = 'sms.net.bd'
const MAX_ATTEMPTS = 2
const DEFAULT_COOLDOWN_MINUTES = 60
const MAX_BATCH = 10

const PERMANENT_ERROR_CODES = new Set(['400', '403', '405', '410', '412', '413', '414', '415', '416', '417', '420', '421'])
const ACTIVE_SMS_TYPES = new Set<SmsType>(['ORDER_CONFIRMATION', 'TRADING_DAILY_SUMMARY', 'SALARY_RECEIVED', 'TEST'])

export async function smsEnabledForBusiness(businessId?: string | null) {
  if (!smsProviderConfigured()) return false
  const id = businessId || 'GLOBAL'
  const setting = await prisma.smsSetting.findUnique({ where: { businessId: id } })
  if (setting) return setting.enabled
  if (id !== 'GLOBAL') {
    const global = await prisma.smsSetting.findUnique({ where: { businessId: 'GLOBAL' } })
    if (global) return global.enabled
  }
  return process.env.SMS_ENABLED === 'true'
}

async function recordSmsSkip(input: QueueSmsInput, reason: string, detail: string) {
  try {
    const phone =
      normalizeSmsPhone(input.phone) ||
      String(input.phone || '')
        .replace(/\D/g, '')
        .slice(0, 20) ||
      'unknown'
    await prisma.smsLog.create({
      data: {
        businessId: input.businessId || null,
        phone,
        message: input.message.slice(0, 918),
        type: input.type,
        provider: PROVIDER,
        status: 'FAILED',
        errorCode: reason,
        errorMessage: detail,
        metadataJson: input.metadata ? JSON.stringify(input.metadata).slice(0, 8000) : null,
      },
    })
  } catch (err) {
    console.error('[sms] recordSmsSkip failed', err)
  }
}

export async function queueSms(input: QueueSmsInput) {
  if (!ACTIVE_SMS_TYPES.has(input.type)) {
    return { ok: false, skipped: true, reason: 'SMS_TYPE_DISABLED' }
  }
  if (!smsProviderConfigured()) {
    await recordSmsSkip(
      input,
      'CONFIG',
      'SMS_API_KEY is not configured on the server.',
    )
    return { ok: false, skipped: true, reason: 'SMS_NOT_CONFIGURED' }
  }
  const phone = normalizeSmsPhone(input.phone)
  if (!phone) {
    await recordSmsSkip(
      input,
      'INVALID_PHONE',
      `Invalid Bangladesh mobile number: ${String(input.phone || '').trim() || '(empty)'}`,
    )
    return { ok: false, skipped: true, reason: 'INVALID_PHONE' }
  }
  const enabled = await smsEnabledForBusiness(input.businessId)
  if (!enabled) {
    await recordSmsSkip(
      input,
      'SMS_DISABLED',
      `SMS is disabled for business ${input.businessId || 'GLOBAL'}. Enable it in Settings → SMS.`,
    )
    return { ok: false, skipped: true, reason: 'SMS_DISABLED' }
  }

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

/** Queue SMS and send immediately — await from API routes before responding. */
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
    take: Math.min(Math.max(options.limit || MAX_BATCH, 1), MAX_BATCH),
  })

  const results = []
  for (const row of rows) {
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
    await prisma.smsLog.update({
      where: { id },
      data: { status: 'FAILED', errorCode: 'SMS_TYPE_DISABLED', errorMessage: 'This SMS type is disabled for the current business stage.', nextAttemptAt: null },
    })
    return { ok: false, error: 'This SMS type is disabled.' }
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
