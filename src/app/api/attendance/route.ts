import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import { attendanceRecordDto, attendanceWaiverDto } from '@/lib/attendance'
import { buildAdminAttendanceDashboard } from '@/lib/attendance-admin-dashboard'
import { logEvent } from '@/lib/logger'
import {
  apiDataSuccess,
  apiFailure,
  withApiRoute,
} from '@/lib/core/safe-api'
import { classifyAttendanceDbError, safeAttendanceQuery } from '@/lib/core/safe-attendance'

export const dynamic = 'force-dynamic'
export const maxDuration = 25

export const GET = withApiRoute(
  'attendance.api',
  async (req: NextRequest) => {
    const started = Date.now()
    const url = new URL(req.url)
    const businessIdParam = url.searchParams.get('business_id')
    const ctx = await getWalletContext(req, businessIdParam)
    if ('error' in ctx && ctx.error) {
      const status = ctx.error.status ?? 403
      if (status === 401) return apiFailure('unauthorized', 'Unauthorized', { status: 401 })
      return apiFailure('forbidden', 'Business not permitted for this user.', { status: 403 })
    }

    const q = await safeAttendanceQuery(req, {
      businessIdParam,
      tokenBusinessAccess: String(ctx.token.businessAccess || ''),
      role: ctx.role,
    })

    const scope = url.searchParams.get('scope') || ''
    const employeeIdParam = url.searchParams.get('employee_id')?.trim()
    const targetEmployeeId = scope === 'me' ? ctx.employeeId : employeeIdParam

    if (scope === 'me' && !ctx.isSystemOwner && !targetEmployeeId) {
      logEvent('warn', 'attendance.get.needs_employee_link', {
        userId: ctx.userId,
        businessId: q.selectedBusinessId,
        durationMs: Date.now() - started,
      })
      return apiDataSuccess({
        businessId: q.selectedBusinessId,
        employeeId: null,
        needsEmployeeLink: true,
        today: null,
        records: [],
        waivers: [],
        summary: {
          presentDays: 0,
          lateCount: 0,
          totalPenalties: 0,
          waivedPenalties: 0,
          averageWorkMinutes: 0,
        },
      })
    }

    if (scope === 'me' && ctx.isSystemOwner) {
      return apiDataSuccess({
        businessId: q.selectedBusinessId,
        employeeId: null,
        systemOwner: true,
        today: null,
        records: [],
        waivers: [],
        summary: {
          presentDays: 0,
          lateCount: 0,
          totalPenalties: 0,
          waivedPenalties: 0,
          averageWorkMinutes: 0,
        },
      })
    }

    if (targetEmployeeId && !ctx.isAdmin && targetEmployeeId !== ctx.employeeId) {
      return apiFailure('forbidden', 'Forbidden', { status: 403 })
    }

    if (targetEmployeeId) {
      const [records, waivers] = await Promise.all([
        prisma.attendanceRecord.findMany({
          where: {
            ...q.archiveWhere,
            businessId: q.selectedBusinessId,
            employeeId: targetEmployeeId,
            attendanceDate: { gte: q.monthStart, lt: q.monthEnd },
          },
          include: { waiverRequests: true, selfieVerifications: true },
          orderBy: { attendanceDate: 'desc' },
          take: 90,
        }),
        prisma.attendanceWaiverRequest.findMany({
          where: {
            ...q.archiveWhere,
            businessId: q.selectedBusinessId,
            employeeId: targetEmployeeId,
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
      ])
      const totalWorkMinutes = records.reduce((sum, r) => sum + r.totalWorkMinutes, 0)
      const lateCount = records.filter(r => r.lateMinutes > 0).length
      const totalPenalties = records.reduce((sum, r) => sum + Number(r.penaltyAmount || 0), 0)
      const waivedPenalties = waivers
        .filter(w => w.status === 'APPROVED' || w.status === 'PARTIALLY_APPROVED')
        .reduce((sum, w) => sum + Number(w.approvedReductionAmount || 0), 0)
      const todayRow = records.find(r => r.attendanceDate.getTime() === q.date.getTime()) || null

      logEvent('info', 'attendance.get.me_ok', {
        userId: ctx.userId,
        employeeId: targetEmployeeId,
        businessId: q.selectedBusinessId,
        recordCount: records.length,
        durationMs: Date.now() - started,
      })

      return apiDataSuccess({
        businessId: q.selectedBusinessId,
        employeeId: targetEmployeeId,
        today: todayRow ? attendanceRecordDto(todayRow) : null,
        records: records.map(attendanceRecordDto),
        waivers: waivers.map(attendanceWaiverDto),
        summary: {
          presentDays: records.length,
          lateCount,
          totalPenalties,
          waivedPenalties,
          averageWorkMinutes: records.length ? Math.round(totalWorkMinutes / records.length) : 0,
        },
      })
    }

    if (!ctx.isAdmin) {
      return apiFailure('invalid_request', 'employee_id or scope=me required', { status: 400 })
    }

    const dashboard = await buildAdminAttendanceDashboard({
      businessIds: q.scopeBusinessIds,
      date: q.date,
      monthStart: q.monthStart,
      monthEnd: q.monthEnd,
      scopeAllBusinesses: q.scopeAllBusinesses,
    })

    logEvent('info', 'attendance.get.admin_ok', {
      userId: ctx.userId,
      businessIds: q.scopeBusinessIds,
      durationMs: Date.now() - started,
    })

    return apiDataSuccess(dashboard as Record<string, unknown>)
  },
  { classifyError: classifyAttendanceDbError },
)
