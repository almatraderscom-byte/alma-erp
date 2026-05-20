import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import { normalizeAlmaRole } from '@/lib/roles'
import { attendanceDateFor, attendanceRecordDto, attendanceWaiverDto } from '@/lib/attendance'
import { resolveAttendanceBusinessScope } from '@/lib/attendance-business'
import { buildAdminAttendanceDashboard } from '@/lib/attendance-admin-dashboard'
import { errorMeta, logEvent } from '@/lib/logger'
import type { AttendanceErrorCode } from '@/lib/attendance-errors'
import { parseArchiveVisibility, resolveArchiveVisibilityWhere } from '@/lib/business-archive/query'

export const dynamic = 'force-dynamic'
export const maxDuration = 25

function parseDateParam(raw: string | null) {
  if (!raw) return attendanceDateFor()
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return attendanceDateFor()
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
}

function monthRange(date: Date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
  return { start, end }
}

function attendanceErrorResponse(status: number, code: AttendanceErrorCode, error: string, retryable = false) {
  return NextResponse.json({ error, code, retryable }, { status })
}

export async function GET(req: NextRequest) {
  const started = Date.now()
  let scope = ''
  let actorUserId = ''
  let employeeId = ''
  try {
  const url = new URL(req.url)
  const archiveVisibility = parseArchiveVisibility(url.searchParams.get('archive_visibility'))
  const archiveWhere = await resolveArchiveVisibilityWhere(archiveVisibility)
  const businessIdParam = url.searchParams.get('business_id')
  const ctx = await getWalletContext(req, businessIdParam)
  if ('error' in ctx) return ctx.error
  actorUserId = ctx.userId
  scope = url.searchParams.get('scope') || ''

  const role = normalizeAlmaRole(ctx.role as string)
  const scopeBusinessIds = resolveAttendanceBusinessScope(
    String(ctx.token.businessAccess || ''),
    businessIdParam,
    role,
  )
  const scopeAllBusinesses = scopeBusinessIds.length > 1
  const selectedBusinessId = scopeBusinessIds[0]
  const date = parseDateParam(url.searchParams.get('date'))
  const { start: monthStart, end: monthEnd } = monthRange(date)
  const employeeIdParam = url.searchParams.get('employee_id')?.trim()
  const targetEmployeeId = scope === 'me' ? ctx.employeeId : employeeIdParam
  employeeId = targetEmployeeId || ''

  if (scope === 'me' && !ctx.isSystemOwner && !targetEmployeeId) {
    logEvent('warn', 'attendance.get.needs_employee_link', {
      userId: actorUserId,
      businessId: selectedBusinessId,
      durationMs: Date.now() - started,
    })
    return NextResponse.json({
      businessId: selectedBusinessId,
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
    return NextResponse.json({
      businessId: selectedBusinessId,
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
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (targetEmployeeId) {
    const [records, waivers] = await Promise.all([
      prisma.attendanceRecord.findMany({
        where: {
          ...archiveWhere,
          businessId: selectedBusinessId,
          employeeId: targetEmployeeId,
          attendanceDate: { gte: monthStart, lt: monthEnd },
        },
        include: { waiverRequests: true, selfieVerifications: true },
        orderBy: { attendanceDate: 'desc' },
        take: 90,
      }),
      prisma.attendanceWaiverRequest.findMany({
        where: {
          ...archiveWhere,
          businessId: selectedBusinessId,
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

    const todayRow = records.find(r => r.attendanceDate.getTime() === date.getTime()) || null
    logEvent('info', 'attendance.get.me_ok', {
      userId: actorUserId,
      employeeId: targetEmployeeId,
      businessId: selectedBusinessId,
      recordCount: records.length,
      durationMs: Date.now() - started,
    })
    return NextResponse.json({
      businessId: selectedBusinessId,
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
    return NextResponse.json({ error: 'employee_id or scope=me required' }, { status: 400 })
  }

  const dashboard = await buildAdminAttendanceDashboard({
    businessIds: scopeBusinessIds,
    date,
    monthStart,
    monthEnd,
    scopeAllBusinesses,
  })

  logEvent('info', 'attendance.get.admin_ok', {
    userId: actorUserId,
    businessIds: scopeBusinessIds,
    scopeAllBusinesses,
    employeeCount: dashboard.kpis.employeeCount,
    todayAttendance: dashboard.kpis.todayAttendance,
    durationMs: Date.now() - started,
  })

  return NextResponse.json(dashboard)
  } catch (e) {
    const meta = {
      ...errorMeta(e),
      userId: actorUserId,
      scope,
      employeeId,
      durationMs: Date.now() - started,
    }
    logEvent('error', 'attendance.get.failed', meta)
    const msg = (e as Error).message || ''
    if (
      msg.includes('faceVerified')
      || msg.includes('faceThumbDataUrl')
      || msg.includes('requestType')
      || msg.includes('does not exist')
      || msg.includes('Unknown field')
    ) {
      return attendanceErrorResponse(
        503,
        'SCHEMA_OUTDATED',
        'Attendance database schema is out of date. Run pending Prisma migrations on production.',
        true,
      )
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && ['P2024', 'P2034'].includes(e.code)) {
      return attendanceErrorResponse(503, 'DB_UNAVAILABLE', 'Database is busy. Please retry in a few seconds.', true)
    }
    return attendanceErrorResponse(500, 'DB_UNAVAILABLE', 'Could not load attendance records.', true)
  }
}
