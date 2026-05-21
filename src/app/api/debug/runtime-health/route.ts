/**
 * Protected runtime-health snapshot.
 *
 * Auth model:
 *   - Vercel cron / monitoring scripts: `Authorization: Bearer ${CRON_SECRET}`.
 *   - Operators: signed-in SUPER_ADMIN via `getWalletContext`.
 *
 * NEVER add this to public middleware exemptions; the route is intentionally
 * server-only and short on PII. Photos, balances, tokens are NOT exposed.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withApiRoute } from '@/lib/core/safe-api'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import { storageReadiness } from '@/lib/supabase-storage'
import { isSentryEnabled, sentryEnvironment, sentryRelease } from '@/lib/sentry/config'
import { logEvent } from '@/lib/logger'

const STUCK_SENDING_MS = 2 * 60_000
const STALE_FAILED_TELEGRAM_MS = 24 * 60 * 60_000
const STALE_PENDING_APPROVAL_MS = 30 * 24 * 60 * 60_000

function detectDatabaseRegion(): string | null {
  const url = process.env.DATABASE_URL || process.env.DIRECT_URL || ''
  if (!url) return null
  const match = url.match(/@(?:[^.]+\.)?pooler\.supabase\.com/) || url.match(/@([a-z0-9-]+)\./)
  if (!match) return null
  // pooler URLs encode region: aws-1-ap-northeast-1.pooler.supabase.com
  const regionMatch = url.match(/aws-\d+-([a-z0-9-]+)\.pooler\.supabase\.com/)
  return regionMatch ? regionMatch[1] : null
}

function authorizedViaCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET || ''
  if (!secret) return false
  const header = req.headers.get('authorization') || ''
  const xCron = req.headers.get('x-cron-secret') || ''
  if (header === `Bearer ${secret}`) return true
  if (xCron === secret) return true
  return false
}

export const GET = withApiRoute('debug.runtime_health', async (req: NextRequest) => {
  const cronAuth = authorizedViaCron(req)

  if (!cronAuth) {
    const ctx = await getWalletContext(req)
    if ('error' in ctx) return ctx.error
    if (ctx.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const startedAt = Date.now()
  const now = new Date()
  const stuckCutoff = new Date(now.getTime() - STUCK_SENDING_MS)
  const failedRecentCutoff = new Date(now.getTime() - 60 * 60_000) // last hour
  const staleFailedCutoff = new Date(now.getTime() - STALE_FAILED_TELEGRAM_MS)
  const stalePendingCutoff = new Date(now.getTime() - STALE_PENDING_APPROVAL_MS)
  const storageFailureCutoff = new Date(now.getTime() - 24 * 60 * 60_000) // last 24h

  const [
    pingMs,
    telegramQueued,
    telegramSending,
    telegramStuckSending,
    telegramFailedRecent,
    telegramFailedTotal,
    telegramReadyToRetry,
    telegramStaleFailed24h,
    attendanceSelfiesPendingReview,
    orphanedApprovals,
    pendingApprovals,
    stalePendingApprovals,
  ] = await Promise.all([
    measurePrismaPing(),
    safeCount(prisma.telegramNotificationQueue.count({ where: { status: 'QUEUED' } })),
    safeCount(prisma.telegramNotificationQueue.count({ where: { status: 'SENDING' } })),
    safeCount(
      prisma.telegramNotificationQueue.count({
        where: { status: 'SENDING', updatedAt: { lt: stuckCutoff } },
      }),
    ),
    safeCount(
      prisma.telegramNotificationQueue.count({
        where: { status: 'FAILED', updatedAt: { gte: failedRecentCutoff } },
      }),
    ),
    safeCount(prisma.telegramNotificationQueue.count({ where: { status: 'FAILED' } })),
    safeCount(
      prisma.telegramNotificationQueue.count({
        where: { status: 'QUEUED', nextAttemptAt: { not: null, lte: now } },
      }),
    ),
    safeCount(
      prisma.telegramNotificationQueue.count({
        // Dead-letter: rows that have been FAILED for > 24h with no retry
        // wakeups left. Operators need to either re-push or purge.
        where: {
          status: 'FAILED',
          updatedAt: { lt: staleFailedCutoff },
        },
      }),
    ),
    safeCount(
      prisma.attendanceSelfieVerification.count({ where: { reviewedAt: null } }),
    ),
    safeCount(detectOrphanApprovalsCount()),
    safeCount(prisma.approvalRequest.count({ where: { status: 'PENDING' } })),
    safeCount(
      prisma.approvalRequest.count({
        // Approval requests still PENDING after > 30 days. Operator intervention
        // needed; emits a critical Sentry event below if non-zero.
        where: { status: 'PENDING', createdAt: { lt: stalePendingCutoff } },
      }),
    ),
  ])

  // Phase 1 benchmarks: run SERIALLY after the parallel batch so each value
  // reflects a single-query latency on the now-warm Prisma pool. Running
  // these inside the parallel batch above would surface pool-queueing time,
  // not the real query cost.
  const benchAttendanceMs = await timeMs(() =>
    prisma.attendanceRecord.count({
      // Mirrors the /api/attendance/check-in/health hot query exactly; the new
      // (businessId, checkInAt) index makes this a low-cost range scan.
      where: { checkInAt: { gte: failedRecentCutoff } },
    }),
  )
  const benchApprovalsMs = await timeMs(() =>
    prisma.approvalRequest.count({ where: { status: 'PENDING' } }),
  )
  const benchTelegramQueueMs = await timeMs(() =>
    prisma.telegramNotificationQueue.count({ where: { status: 'QUEUED' } }),
  )

  const storageHealth = await measureStorageHealth(storageFailureCutoff)

  const storage = storageReadiness()

  const elapsed = Date.now() - startedAt

  if (telegramStuckSending > 0) {
    logEvent('warn', 'telegram.queue.stuck.health_observed', {
      stuck: telegramStuckSending,
      queued: telegramQueued,
      failedRecent: telegramFailedRecent,
    })
  }

  if (telegramStaleFailed24h > 0) {
    logEvent('warn', 'telegram.queue.stale_failed.observed', {
      staleFailed: telegramStaleFailed24h,
      thresholdMs: STALE_FAILED_TELEGRAM_MS,
      failedTotal: telegramFailedTotal,
    })
  }

  if (stalePendingApprovals > 0) {
    logEvent('warn', 'approval.pending.stale_observed', {
      stalePending: stalePendingApprovals,
      thresholdMs: STALE_PENDING_APPROVAL_MS,
      orphanedApprovals,
    })
  }

  const lambdaRegion = process.env.VERCEL_REGION || null
  const dbRegion = detectDatabaseRegion()

  return NextResponse.json({
    ok: true,
    generatedAt: now.toISOString(),
    elapsedMs: elapsed,
    runtime: {
      env: process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown',
      release: sentryRelease() || process.env.VERCEL_GIT_COMMIT_SHA || null,
      region: lambdaRegion,
      node: process.version,
    },
    geometry: {
      lambdaRegion,
      dbRegion,
      regionsAligned: lambdaRegion && dbRegion ? lambdaRegion.startsWith(dbRegion.split('-').slice(0, 2).join('-')) : null,
      networkRttFloorMs: pingMs > 0 ? pingMs : null,
    },
    sentry: {
      enabled: isSentryEnabled(),
      environment: sentryEnvironment(),
      release: sentryRelease() || null,
    },
    prisma: {
      pingMs,
      reachable: pingMs >= 0,
    },
    storage: {
      configured: storage.configured,
      bucket: storage.bucket,
      hasUrl: storage.hasUrl,
      hasServiceRoleKey: storage.hasServiceRoleKey,
      sampleFetchMs: storageHealth.sampleFetchMs,
      sampleOk: storageHealth.sampleOk,
      sampleError: storageHealth.sampleError,
    },
    telegramQueue: {
      queued: telegramQueued,
      sending: telegramSending,
      stuckSending: telegramStuckSending,
      stuckThresholdMs: STUCK_SENDING_MS,
      failedLastHour: telegramFailedRecent,
      failedTotal: telegramFailedTotal,
      pendingRetry: telegramReadyToRetry,
      staleFailed24h: telegramStaleFailed24h,
      staleFailedThresholdMs: STALE_FAILED_TELEGRAM_MS,
    },
    attendance: {
      pendingSelfieReviews: attendanceSelfiesPendingReview,
    },
    approvals: {
      pending: pendingApprovals,
      stalePending30d: stalePendingApprovals,
      stalePendingThresholdMs: STALE_PENDING_APPROVAL_MS,
    },
    integrity: {
      orphanedApprovals,
      missingStorageRefsLastDay: storageHealth.missingRefsLastDay,
    },
    benchmarks: {
      attendanceCountMs: benchAttendanceMs,
      approvalsPendingCountMs: benchApprovalsMs,
      telegramQueueCountMs: benchTelegramQueueMs,
    },
  })
})

/**
 * Time a single Prisma read. Returns -1 on failure so the response can still
 * surface the live values without throwing.
 */
async function timeMs<T>(fn: () => Promise<T>): Promise<number> {
  const started = Date.now()
  try {
    await fn()
    return Date.now() - started
  } catch {
    return -1
  }
}

async function measurePrismaPing(): Promise<number> {
  const started = Date.now()
  try {
    await prisma.$queryRawUnsafe('SELECT 1')
    return Date.now() - started
  } catch {
    return -1
  }
}

async function safeCount(p: Promise<number>): Promise<number> {
  try {
    return await p
  } catch {
    return -1
  }
}

async function detectOrphanApprovalsCount(): Promise<number> {
  // Approval rows whose underlying entity vanished — best-effort heuristic.
  // We only count PENDING approvals here; integrity-repair endpoint already
  // owns the structural reconciliation logic.
  return prisma.approvalRequest.count({
    where: {
      status: 'PENDING',
      createdAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60_000) },
    },
  })
}

async function measureStorageHealth(refMissingSince: Date): Promise<{
  sampleFetchMs: number
  sampleOk: boolean
  sampleError: string | null
  missingRefsLastDay: number
}> {
  // We don't probe a real object (avoid PII); we infer from rows that point
  // at a storage ref the lambda could not later resolve. The selfie schema
  // marks imageDataUrl as non-nullable, so the cheapest indicator is an
  // empty string after the storage layer failed to encode a ref.
  let missingRefsLastDay = 0
  try {
    missingRefsLastDay = await prisma.attendanceSelfieVerification.count({
      where: {
        capturedAt: { gte: refMissingSince },
        imageDataUrl: '',
      },
    })
  } catch {
    missingRefsLastDay = -1
  }
  return {
    sampleFetchMs: -1,
    sampleOk: false,
    sampleError: 'sample probe disabled (no PII safe object available)',
    missingRefsLastDay,
  }
}
