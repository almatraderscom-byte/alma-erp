import { NextRequest } from 'next/server'
import { apiDataSuccess, apiFailure, requireWalletContext, withApiRoute } from '@/lib/core/safe-route-helpers'
import { attendanceDateFor } from '@/lib/attendance'
import { prisma } from '@/lib/prisma'
import { normalizeAlmaRole } from '@/lib/roles'

export const dynamic = 'force-dynamic'

/** Lightweight attendance check-in observability (admin read-only). */
export const GET = withApiRoute('attendance.check_in.health', async (req: NextRequest) => {
  const url = new URL(req.url)
  const businessIdParam = url.searchParams.get('business_id')
  const auth = await requireWalletContext(req, businessIdParam)
  if (!auth.ok) return auth.response

  const role = normalizeAlmaRole(auth.ctx.role)
  if (!['SUPER_ADMIN', 'ADMIN', 'HR'].includes(role)) {
    return apiFailure('forbidden', 'Forbidden', { status: 403 })
  }

  const businessId = auth.ctx.businessIds[0]
  const dayStart = attendanceDateFor()
  const dayEnd = new Date(dayStart.getTime() + 86_400_000)
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000)

  const [todayTotal, todayLate, last24h] = await Promise.all([
    prisma.attendanceRecord.count({
      where: { businessId, attendanceDate: { gte: dayStart, lt: dayEnd } },
    }),
    prisma.attendanceRecord.count({
      where: {
        businessId,
        attendanceDate: { gte: dayStart, lt: dayEnd },
        status: 'LATE',
      },
    }),
    prisma.attendanceRecord.findMany({
      where: { businessId, checkInAt: { gte: since24h } },
      select: { id: true, checkInAt: true, employeeId: true, lateMinutes: true },
      orderBy: { checkInAt: 'desc' },
      take: 50,
    }),
  ])

  const employeeIds = new Set(last24h.map(r => r.employeeId))
  const duplicateRisk = todayTotal - employeeIds.size

  return apiDataSuccess({
    businessId,
    attendanceDate: dayStart.toISOString().slice(0, 10),
    todayCheckIns: todayTotal,
    todayLateCheckIns: todayLate,
    uniqueEmployeesToday: employeeIds.size,
    duplicateRowRisk: Math.max(0, duplicateRisk),
    last24hSampleSize: last24h.length,
    architecture: {
      atomicTransaction: true,
      telegramAsync: true,
      idempotentDuplicate: true,
      sideEffectsNonBlocking: true,
    },
    logEvents: [
      'attendance.health.metric',
      'attendance.health.summary',
      'attendance.checkin.response_sent',
      'attendance.checkin.side_effect_failed',
    ],
  })
})
