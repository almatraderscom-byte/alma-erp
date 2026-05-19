import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import { attendanceDateFor, attendanceRecordDto, attendanceWaiverDto } from '@/lib/attendance'
import { resolveProfileImageForUser } from '@/lib/user-display'

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

function minutesLabel(minutes: number) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (!h) return `${m}m`
  return `${h}h ${m}m`
}

export async function GET(req: NextRequest) {
  try {
  const url = new URL(req.url)
  const businessId = url.searchParams.get('business_id')
  const ctx = await getWalletContext(req, businessId)
  if ('error' in ctx) return ctx.error

  const selectedBusinessId = ctx.businessIds[0]
  const date = parseDateParam(url.searchParams.get('date'))
  const { start: monthStart, end: monthEnd } = monthRange(date)
  const employeeId = url.searchParams.get('employee_id')?.trim()
  const scope = url.searchParams.get('scope')
  const targetEmployeeId = scope === 'me' ? ctx.employeeId : employeeId

  if (scope === 'me' && !ctx.isSystemOwner && !targetEmployeeId) {
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
          businessId: selectedBusinessId,
          employeeId: targetEmployeeId,
          attendanceDate: { gte: monthStart, lt: monthEnd },
        },
        include: { waiverRequests: true, selfieVerifications: true },
        orderBy: { attendanceDate: 'desc' },
        take: 90,
      }),
      prisma.attendanceWaiverRequest.findMany({
        where: { businessId: selectedBusinessId, employeeId: targetEmployeeId },
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

    return NextResponse.json({
      businessId: selectedBusinessId,
      employeeId: targetEmployeeId,
      today: records.find(r => r.attendanceDate.getTime() === date.getTime()) ? attendanceRecordDto(records.find(r => r.attendanceDate.getTime() === date.getTime())!) : null,
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

  const [employees, todayRecords, monthRecords, pendingWaivers, selfieRows] = await Promise.all([
    prisma.user.findMany({
      where: {
        active: true,
        role: { not: 'SUPER_ADMIN' },
        employeeIdGas: { not: null },
        businessAccess: { contains: selectedBusinessId },
      },
      select: { id: true, name: true, email: true, employeeIdGas: true, profileImageUrl: true, updatedAt: true },
      orderBy: { name: 'asc' },
    }),
    prisma.attendanceRecord.findMany({
      where: { businessId: selectedBusinessId, attendanceDate: date },
      include: {
        user: { select: { id: true, name: true, email: true, profileImageUrl: true, updatedAt: true } },
        waiverRequests: true,
        selfieVerifications: true,
      },
      orderBy: { checkInAt: 'asc' },
    }),
    prisma.attendanceRecord.findMany({
      where: { businessId: selectedBusinessId, attendanceDate: { gte: monthStart, lt: monthEnd } },
      include: { user: { select: { name: true } } },
      orderBy: { attendanceDate: 'desc' },
    }),
    prisma.attendanceWaiverRequest.findMany({
      where: { businessId: selectedBusinessId, status: 'PENDING' },
      include: {
        requester: { select: { id: true, name: true, email: true, profileImageUrl: true, updatedAt: true } },
        attendanceRecord: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    }),
    prisma.attendanceSelfieVerification.findMany({
      where: { businessId: selectedBusinessId, capturedAt: { gte: monthStart, lt: monthEnd } },
      orderBy: { capturedAt: 'desc' },
      take: 8,
    }),
  ])

  const presentEmployeeIds = new Set(todayRecords.map(r => r.employeeId))
  const absentEmployees = employees.filter(e => e.employeeIdGas && !presentEmployeeIds.has(e.employeeIdGas))
  const lateRecords = todayRecords.filter(r => r.lateMinutes > 0)
  const suspiciousRecords = todayRecords.filter(r => r.trustStatus !== 'TRUSTED' || r.verificationRequired)
  const todayPenaltyTotal = todayRecords.reduce((sum, r) => sum + Number(r.penaltyAmount || 0), 0)
  const monthPenaltyTotal = monthRecords.reduce((sum, r) => sum + Number(r.penaltyAmount || 0), 0)
  const elapsedMonthDays = Math.max(1, Math.min(date.getUTCDate(), new Date().getUTCDate()))
  const attendanceRate = employees.length ? Math.round((monthRecords.length / (employees.length * elapsedMonthDays)) * 100) : 0

  const ranking = employees.map(employee => {
    const rows = monthRecords.filter(r => r.employeeId === employee.employeeIdGas)
    const lateCount = rows.filter(r => r.lateMinutes > 0).length
    const penaltyTotal = rows.reduce((sum, r) => sum + Number(r.penaltyAmount || 0), 0)
    const avgWork = rows.length ? Math.round(rows.reduce((sum, r) => sum + r.totalWorkMinutes, 0) / rows.length) : 0
    return {
      userId: employee.id,
      employeeId: employee.employeeIdGas,
      name: employee.name,
      profileImageUrl: resolveProfileImageForUser(employee),
      presentDays: rows.length,
      lateCount,
      penaltyTotal,
      averageWorkMinutes: avgWork,
      averageWorkLabel: minutesLabel(avgWork),
      punctualityScore: Math.max(0, 100 - lateCount * 12 - Math.round(penaltyTotal / 100) * 5),
    }
  }).sort((a, b) => b.punctualityScore - a.punctualityScore)

  return NextResponse.json({
    businessId: selectedBusinessId,
    date: date.toISOString(),
    kpis: {
      employeeCount: employees.length,
      todayAttendance: todayRecords.length,
      absentEmployees: absentEmployees.length,
      lateEmployees: lateRecords.length,
      todayPenaltyTotal,
      monthPenaltyTotal,
      attendanceRate,
      pendingWaivers: pendingWaivers.length,
      suspiciousAttendance: suspiciousRecords.length,
      pendingVerifications: todayRecords.filter(r => r.verificationRequired).length,
    },
    records: todayRecords.map(record => ({
      ...attendanceRecordDto(record),
      employeeName: record.user.name,
      employeeEmail: record.user.email,
      profileImageUrl: resolveProfileImageForUser(record.user),
    })),
    absentEmployees: absentEmployees.map(e => ({
      id: e.id,
      employeeId: e.employeeIdGas,
      name: e.name,
      email: e.email,
      profileImageUrl: resolveProfileImageForUser(e),
    })),
    pendingWaivers: pendingWaivers.map(w => ({
      ...attendanceWaiverDto(w),
      requesterUserId: w.requester.id,
      requesterName: w.requester.name,
      requesterEmail: w.requester.email,
      requesterProfileImageUrl: resolveProfileImageForUser(w.requester),
      lateMinutes: w.attendanceRecord.lateMinutes,
    })),
    selfieLogs: selfieRows.map(row => ({
      id: row.id,
      attendanceRecordId: row.attendanceRecordId,
      employeeId: row.employeeId,
      capturedAt: row.capturedAt.toISOString(),
      sizeBytes: row.sizeBytes,
      imageDataUrl: row.imageDataUrl,
      reviewedAt: row.reviewedAt?.toISOString() || null,
    })),
    ranking,
  })
  } catch (e) {
    console.error('[attendance GET]', (e as Error).message)
    const msg = (e as Error).message || ''
    if (msg.includes('faceVerified') || msg.includes('requestType') || msg.includes('does not exist')) {
      return NextResponse.json(
        { error: 'Attendance database schema is out of date. Run pending Prisma migrations on production.' },
        { status: 503 },
      )
    }
    return NextResponse.json({ error: 'Could not load attendance records.' }, { status: 500 })
  }
}
