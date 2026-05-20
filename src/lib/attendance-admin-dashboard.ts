import type { BusinessId } from '@/lib/businesses'
import { prisma } from '@/lib/prisma'
import { attendanceDateFor, attendanceRecordDto, attendanceWaiverDto } from '@/lib/attendance'
import { loadAttendanceRoster, dedupeEmployeesByUserId } from '@/lib/attendance-business'
import { resolveProfileImageForUser } from '@/lib/user-display'
import { scanAttendanceIntegrity } from '@/lib/attendance-integrity'
import { isBusinessArchiveSchemaReady } from '@/lib/business-archive/availability'

function minutesLabel(minutes: number) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (!h) return `${m}m`
  return `${h}h ${m}m`
}

async function loadRosterForScope(businessIds: BusinessId[], monthStart: Date, monthEnd: Date) {
  const rows = []
  for (const businessId of businessIds) {
    rows.push(...await loadAttendanceRoster(businessId, monthStart, monthEnd))
  }
  return dedupeEmployeesByUserId(rows)
}

export async function buildAdminAttendanceDashboard(input: {
  businessIds: BusinessId[]
  date: Date
  monthStart: Date
  monthEnd: Date
  scopeAllBusinesses: boolean
}) {
  const { businessIds, date, monthStart, monthEnd, scopeAllBusinesses } = input
  const archiveReady = await isBusinessArchiveSchemaReady()
  const archiveClause = archiveReady ? { isArchived: false as const } : {}
  const businessFilter = businessIds.length === 1
    ? { businessId: businessIds[0], ...archiveClause }
    : { businessId: { in: businessIds }, ...archiveClause }

  const [employees, todayRecords, monthRecords, pendingWaivers, selfieRows, integrity] = await Promise.all([
    loadRosterForScope(businessIds, monthStart, monthEnd),
    prisma.attendanceRecord.findMany({
      where: { ...businessFilter, attendanceDate: date },
      include: {
        user: { select: { id: true, name: true, email: true, profileImageUrl: true, updatedAt: true } },
        waiverRequests: true,
        selfieVerifications: true,
      },
      orderBy: [{ businessId: 'asc' }, { checkInAt: 'asc' }],
    }),
    prisma.attendanceRecord.findMany({
      where: { ...businessFilter, attendanceDate: { gte: monthStart, lt: monthEnd } },
      include: { user: { select: { name: true } } },
      orderBy: { attendanceDate: 'desc' },
    }),
    prisma.attendanceWaiverRequest.findMany({
      where: { ...businessFilter, status: 'PENDING' },
      include: {
        requester: { select: { id: true, name: true, email: true, profileImageUrl: true, updatedAt: true } },
        attendanceRecord: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    }),
    prisma.attendanceSelfieVerification.findMany({
      where: {
        ...businessFilter,
        capturedAt: { gte: monthStart, lt: monthEnd },
      },
      orderBy: { capturedAt: 'desc' },
      take: 24,
    }),
    scanAttendanceIntegrity(businessIds, date),
  ])

  const presentEmployeeIds = new Set(todayRecords.map(r => r.employeeId))
  const absentEmployees = employees.filter(
    e => e.employeeIdGas && !presentEmployeeIds.has(e.employeeIdGas),
  )
  const lateRecords = todayRecords.filter(r => r.lateMinutes > 0)
  const suspiciousRecords = todayRecords.filter(
    r => r.trustStatus !== 'TRUSTED' || r.verificationRequired,
  )
  const todayPenaltyTotal = todayRecords.reduce((sum, r) => sum + Number(r.penaltyAmount || 0), 0)
  const monthPenaltyTotal = monthRecords.reduce((sum, r) => sum + Number(r.penaltyAmount || 0), 0)
  const elapsedMonthDays = Math.max(1, Math.min(date.getUTCDate(), attendanceDateFor().getUTCDate()))
  const attendanceRate = employees.length
    ? Math.round((monthRecords.length / (employees.length * elapsedMonthDays)) * 100)
    : 0

  const ranking = employees
    .map(employee => {
      const rows = monthRecords.filter(r => r.employeeId === employee.employeeIdGas)
      const lateCount = rows.filter(r => r.lateMinutes > 0).length
      const penaltyTotal = rows.reduce((sum, r) => sum + Number(r.penaltyAmount || 0), 0)
      const avgWork = rows.length
        ? Math.round(rows.reduce((sum, r) => sum + r.totalWorkMinutes, 0) / rows.length)
        : 0
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
    })
    .sort((a, b) => b.punctualityScore - a.punctualityScore)

  const crossBusinessHint = integrity.issues
    .filter((i): i is Extract<typeof i, { kind: 'cross_business_activity' }> => i.kind === 'cross_business_activity')
    .map(i => ({ businessId: i.businessId, todayCount: i.todayCount }))

  return {
    businessId: scopeAllBusinesses ? 'ALL' : businessIds[0],
    businessIds,
    scopeAllBusinesses,
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
    integrity: {
      issueCount: integrity.issues.length,
      issues: integrity.issues.slice(0, 20),
      todayActivityByBusiness: integrity.todayActivityByBusiness,
      crossBusinessHint,
    },
  }
}
