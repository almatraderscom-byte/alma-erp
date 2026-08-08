import type { BusinessId } from '@/lib/businesses'
import { prisma } from '@/lib/prisma'
import { attendanceDateFor, attendanceRecordDto, attendanceWaiverDto } from '@/lib/attendance'
import { resolveAttendanceImageRefForDisplay } from '@/lib/attendance-photo-storage'
import { loadAttendanceRoster, dedupeEmployeesByUserId } from '@/lib/attendance-business'
import { resolveProfileImageForUser } from '@/lib/user-display'
import { scanAttendanceIntegrity } from '@/lib/attendance-integrity'
import { isBusinessArchiveSchemaReady } from '@/lib/business-archive/availability'
import { resolveAttendancePenaltyTarget } from '@/lib/attendance-penalty-target'
import { reconcilePenaltyAppealRefund } from '@/lib/wallet-transparency'

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
  const businessOnly = businessIds.length === 1
    ? { businessId: businessIds[0] }
    : { businessId: { in: businessIds } }
  /** Only AttendanceRecord / AttendanceWaiverRequest have isArchived — not SelfieVerification. */
  const archivedBusinessFilter = { ...businessOnly, ...archiveClause }

  const [employees, todayRecords, monthRecords, pendingWaivers, recentDecisions, selfieRows, integrity] = await Promise.all([
    loadRosterForScope(businessIds, monthStart, monthEnd),
    prisma.attendanceRecord.findMany({
      where: { ...archivedBusinessFilter, attendanceDate: date },
      include: {
        user: { select: { id: true, name: true, email: true, profileImageUrl: true, updatedAt: true } },
        _count: { select: { waiverRequests: true, selfieVerifications: true } },
      },
      orderBy: [{ businessId: 'asc' }, { checkInAt: 'asc' }],
    }),
    prisma.attendanceRecord.findMany({
      where: { ...archivedBusinessFilter, attendanceDate: { gte: monthStart, lt: monthEnd } },
      include: { user: { select: { name: true } } },
      orderBy: { attendanceDate: 'desc' },
    }),
    prisma.attendanceWaiverRequest.findMany({
      where: { ...archivedBusinessFilter, status: 'PENDING' },
      include: {
        requester: { select: { id: true, name: true, email: true, profileImageUrl: true, updatedAt: true } },
        attendanceRecord: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    }),
    prisma.attendanceWaiverRequest.findMany({
      where: {
        ...archivedBusinessFilter,
        status: { in: ['APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'CANCELLED'] },
      },
      include: {
        requester: { select: { id: true, name: true, email: true, profileImageUrl: true, updatedAt: true } },
        reviewer: { select: { name: true } },
        attendanceRecord: true,
      },
      orderBy: [{ reviewedAt: 'desc' }, { updatedAt: 'desc' }],
      take: 20,
    }),
    prisma.attendanceSelfieVerification.findMany({
      where: {
        ...businessOnly,
        capturedAt: { gte: monthStart, lt: monthEnd },
      },
      orderBy: { capturedAt: 'desc' },
      take: 24,
    }),
    scanAttendanceIntegrity(businessIds, date),
  ])

  const presentEmployeeIds = new Set(todayRecords.map(r => r.employeeId))
  const pendingUserIds = Array.from(new Set(pendingWaivers.map(w => w.userId)))
  const pendingDates = pendingWaivers.map(w => w.attendanceRecord.attendanceDate)
  const minPendingDate = pendingDates.length
    ? new Date(Math.min(...pendingDates.map(d => d.getTime())))
    : null
  const maxPendingDate = pendingDates.length
    ? new Date(Math.max(...pendingDates.map(d => d.getTime())))
    : null
  const [appealExceptions, appealLeaves] = pendingUserIds.length && minPendingDate && maxPendingDate
    ? await Promise.all([
        prisma.attendanceException.findMany({
          where: {
            ...businessOnly,
            userId: { in: pendingUserIds },
            attendanceDate: { gte: minPendingDate, lte: maxPendingDate },
          },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.attendanceLeave.findMany({
          where: {
            ...businessOnly,
            userId: { in: pendingUserIds },
            startDate: { lte: maxPendingDate },
            endDate: { gte: minPendingDate },
          },
          orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        }),
      ])
    : [[], []]
  const recentRefundIds = recentDecisions
    .map(row => row.reversalLedgerEntryId)
    .filter((id): id is string => Boolean(id))
  const recentRefundRows = recentRefundIds.length
    ? await prisma.employeeLedgerEntry.findMany({
        where: { id: { in: recentRefundIds }, isArchived: false },
        select: { id: true, type: true, amount: true, source: true, relatedEntryId: true },
      })
    : []
  const recentRefundMap = new Map(recentRefundRows.map(row => [row.id, row]))
  const absentEmployees = employees.filter(
    e => e.employeeIdGas && !presentEmployeeIds.has(e.employeeIdGas),
  )
  const lateRecords = todayRecords.filter(r => r.lateMinutes > 0)
  const suspiciousRecords = todayRecords.filter(
    r => r.trustStatus !== 'TRUSTED' || r.verificationRequired,
  )
  const recordPenaltyTotal = (r: {
    penaltyAmount: unknown
    earlyLeavePenaltyAmount: unknown
    noCheckoutFineAmount: unknown
  }) =>
    Number(r.penaltyAmount || 0)
    + Number(r.earlyLeavePenaltyAmount || 0)
    + Number(r.noCheckoutFineAmount || 0)
  const todayPenaltyTotal = todayRecords.reduce((sum, r) => sum + recordPenaltyTotal(r), 0)
  const monthPenaltyTotal = monthRecords.reduce((sum, r) => sum + recordPenaltyTotal(r), 0)
  const elapsedMonthDays = Math.max(1, Math.min(date.getUTCDate(), attendanceDateFor().getUTCDate()))
  const attendanceRate = employees.length
    ? Math.round((monthRecords.length / (employees.length * elapsedMonthDays)) * 100)
    : 0

  const ranking = employees
    .map(employee => {
      const rows = monthRecords.filter(r => r.employeeId === employee.employeeIdGas)
      const lateCount = rows.filter(r => r.lateMinutes > 0).length
      const penaltyTotal = rows.reduce((sum, r) => sum + recordPenaltyTotal(r), 0)
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
    pendingWaivers: pendingWaivers.map(w => {
      const resolvedPenalty = resolveAttendancePenaltyTarget(
        w.attendanceRecord,
        w.penaltyLedgerEntryId,
        w.originalPenaltyAmount,
      )
      const exception = appealExceptions.find(row =>
        row.userId === w.userId
        && row.businessId === w.businessId
        && row.attendanceDate.getTime() === w.attendanceRecord.attendanceDate.getTime(),
      )
      const coveringLeaves = appealLeaves.filter(row =>
        row.userId === w.userId
        && row.businessId === w.businessId
        && row.startDate.getTime() <= w.attendanceRecord.attendanceDate.getTime()
        && row.endDate.getTime() >= w.attendanceRecord.attendanceDate.getTime(),
      )
      const leave = coveringLeaves.find(row => row.status === 'APPROVED') || coveringLeaves[0]
      return {
        ...attendanceWaiverDto(w),
        requesterUserId: w.requester.id,
        requesterName: w.requester.name,
        requesterEmail: w.requester.email,
        requesterProfileImageUrl: resolveProfileImageForUser(w.requester),
        penaltyLedgerEntryId: resolvedPenalty?.ledgerEntryId || null,
        lateMinutes: w.attendanceRecord.lateMinutes,
        penaltyKind: resolvedPenalty?.kind || 'UNKNOWN',
        penaltyMinutes:
          resolvedPenalty?.kind === 'EARLY_LEAVE'
            ? w.attendanceRecord.earlyLeaveMinutes
            : w.attendanceRecord.lateMinutes,
        reviewContext: {
          exception: exception ? {
            status: exception.status,
            scope: exception.scope,
            reason: exception.reason,
            adminNote: exception.adminNote,
          } : null,
          leave: leave ? {
            status: leave.status,
            kind: leave.kind,
            reason: leave.reason,
            adminNote: leave.adminNote,
          } : null,
        },
        attachmentUrl: w.attachmentDataUrl
          ? `/api/attendance/waivers/${w.id}/attachment?business_id=${encodeURIComponent(w.businessId)}`
          : null,
      }
    }),
    recentWaiverDecisions: recentDecisions.map(w => {
      const resolvedPenalty = resolveAttendancePenaltyTarget(
        w.attendanceRecord,
        w.penaltyLedgerEntryId,
        w.originalPenaltyAmount,
      )
      const reconciliation = reconcilePenaltyAppealRefund(
        w,
        resolvedPenalty?.ledgerEntryId,
        recentRefundMap,
      )
      return {
        ...attendanceWaiverDto(w),
        requesterUserId: w.requester.id,
        requesterName: w.requester.name,
        requesterProfileImageUrl: resolveProfileImageForUser(w.requester),
        penaltyLedgerEntryId: resolvedPenalty?.ledgerEntryId || null,
        reviewerName: w.reviewer?.name || null,
        attendanceDate: w.attendanceRecord.attendanceDate.toISOString(),
        penaltyKind: resolvedPenalty?.kind || 'UNKNOWN',
        refundAmount: reconciliation.refundedAmount,
        refundReconciled: reconciliation.refundReconciled,
        refundIssue: reconciliation.refundIssue,
        attachmentUrl: w.attachmentDataUrl
          ? `/api/attendance/waivers/${w.id}/attachment?business_id=${encodeURIComponent(w.businessId)}`
          : null,
      }
    }),
    selfieLogs: await Promise.all(
      selfieRows.map(async row => {
        const imageUrl = await resolveAttendanceImageRefForDisplay(row.imageDataUrl)
        return {
          id: row.id,
          businessId: row.businessId,
          attendanceRecordId: row.attendanceRecordId,
          employeeId: row.employeeId,
          capturedAt: row.capturedAt.toISOString(),
          sizeBytes: row.sizeBytes,
          imageDataUrl: row.imageDataUrl,
          imageUrl,
          imageMissing: !imageUrl,
          reviewedAt: row.reviewedAt?.toISOString() || null,
        }
      }),
    ),
    ranking,
    integrity: {
      issueCount: integrity.issues.length,
      issues: integrity.issues.slice(0, 20),
      todayActivityByBusiness: integrity.todayActivityByBusiness,
      crossBusinessHint,
    },
  }
}
