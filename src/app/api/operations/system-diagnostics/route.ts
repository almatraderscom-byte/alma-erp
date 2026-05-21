import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import { getTelegramQueueHealth, processTelegramNotificationQueue, retryAllFailedTelegramNotifications } from '@/lib/telegram-notification/queue'
import { ATTENDANCE_STORAGE_REF_PREFIX } from '@/lib/attendance-photo-storage'
import { logEvent } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

async function getSelfieStorageDiagnostics(businessIds: string[]) {
  const since24h = new Date(Date.now() - 24 * 60 * 60_000)
  const businessWhere = businessIds.length === 1
    ? { businessId: businessIds[0] }
    : { businessId: { in: businessIds } }

  const [totalRecent, missingStorageRef, recentLogs] = await Promise.all([
    prisma.attendanceSelfieVerification.count({
      where: { ...businessWhere, capturedAt: { gte: since24h } },
    }),
    prisma.attendanceSelfieVerification.count({
      where: {
        ...businessWhere,
        capturedAt: { gte: since24h },
        NOT: { imageDataUrl: { startsWith: ATTENDANCE_STORAGE_REF_PREFIX } },
      },
    }),
    prisma.attendanceSelfieVerification.findMany({
      where: { ...businessWhere, capturedAt: { gte: since24h } },
      orderBy: { capturedAt: 'desc' },
      take: 20,
      select: {
        id: true,
        employeeId: true,
        capturedAt: true,
        sizeBytes: true,
        imageDataUrl: true,
        reviewedAt: true,
      },
    }),
  ])

  return {
    last24hTotal: totalRecent,
    missingStorageRefCount: missingStorageRef,
    recentLogs: recentLogs.map(row => ({
      id: row.id,
      employeeId: row.employeeId,
      capturedAt: row.capturedAt.toISOString(),
      sizeBytes: row.sizeBytes,
      storageType: row.imageDataUrl?.startsWith(ATTENDANCE_STORAGE_REF_PREFIX)
        ? 'supabase'
        : row.imageDataUrl?.startsWith('data:image/')
          ? 'inline_base64'
          : 'unknown',
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
    })),
  }
}

async function getRecentTelegramLogs(businessIds: string[]) {
  const businessWhere = businessIds.length === 1
    ? { businessId: businessIds[0] }
    : { businessId: { in: businessIds } }

  const rows = await prisma.telegramNotificationQueue.findMany({
    where: { ...businessWhere },
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: {
      id: true,
      eventType: true,
      status: true,
      attempts: true,
      maxAttempts: true,
      chatId: true,
      createdAt: true,
      sentAt: true,
      errorMessage: true,
      nextAttemptAt: true,
    },
  })

  return rows.map(r => ({
    id: r.id,
    eventType: r.eventType,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    chatId: r.chatId,
    createdAt: r.createdAt.toISOString(),
    sentAt: r.sentAt?.toISOString() ?? null,
    errorMessage: r.errorMessage ?? null,
    nextAttemptAt: r.nextAttemptAt?.toISOString() ?? null,
    ageMinutes: Math.round((Date.now() - r.createdAt.getTime()) / 60_000),
  }))
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const ctx = await getWalletContext(req, url.searchParams.get('business_id'))
  if ('error' in ctx) return ctx.error
  if (ctx.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'SUPER_ADMIN only' }, { status: 403 })
  }

  const [telegramHealth, selfieStorage, recentTelegramLogs] = await Promise.all([
    getTelegramQueueHealth(ctx.businessIds[0]),
    getSelfieStorageDiagnostics(ctx.businessIds),
    getRecentTelegramLogs(ctx.businessIds),
  ])

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    config: {
      botTokenConfigured: telegramHealth.botTokenConfigured,
      cronSecretConfigured: telegramHealth.cronSecretConfigured,
      ownerChatIdsConfigured: telegramHealth.ownerChatIdsEnv,
      storageConfigured: Boolean(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL),
    },
    telegramQueue: {
      byStatus: telegramHealth.byStatus,
      pendingDepth: telegramHealth.pendingDepth,
      stuckSending: telegramHealth.stuckSending,
      processingCount: telegramHealth.processingCount,
      retryWaitCount: telegramHealth.retryWaitCount,
      oldestQueued: telegramHealth.oldestQueued,
      averageDeliveryLatencyMs: telegramHealth.averageDeliveryLatencyMs,
    },
    selfieStorage,
    recentTelegramLogs,
  })
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    business_id?: string
    action?: 'process_queue' | 'retry_failed' | 'retry_single'
    id?: string
    limit?: number
  }
  const ctx = await getWalletContext(req, body.business_id)
  if ('error' in ctx) return ctx.error
  if (ctx.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'SUPER_ADMIN only' }, { status: 403 })
  }

  const action = body.action

  if (action === 'process_queue') {
    const limit = Math.min(Number(body.limit || 30), 50)
    logEvent('info', 'ops.system_diagnostics.process_queue', {
      businessId: ctx.businessIds[0],
      userId: ctx.userId,
      limit,
    })
    const result = await processTelegramNotificationQueue({ limit })
    return NextResponse.json({ ok: true, action, result })
  }

  if (action === 'retry_failed') {
    const limit = Math.min(Number(body.limit || 40), 100)
    logEvent('info', 'ops.system_diagnostics.retry_failed', {
      businessId: ctx.businessIds[0],
      userId: ctx.userId,
      limit,
    })
    const result = await retryAllFailedTelegramNotifications(ctx.businessIds[0], limit)
    return NextResponse.json({ ok: true, action, result })
  }

  if (action === 'retry_single' && body.id) {
    logEvent('info', 'ops.system_diagnostics.retry_single', {
      businessId: ctx.businessIds[0],
      userId: ctx.userId,
      id: body.id,
    })
    const { retryTelegramNotification } = await import('@/lib/telegram-notification/queue')
    const result = await retryTelegramNotification(body.id)
    return NextResponse.json({ ok: true, action, result })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
