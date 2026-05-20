import type { AttendanceRecord } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { parseBusinessAccess } from '@/lib/business-access'
import { userHasBusinessAccess } from '@/lib/attendance-business'
import { attendanceDateFor, ATTENDANCE_TIMEZONE } from '@/lib/attendance'
import { logEvent } from '@/lib/logger'

/** Extra BD-local minutes after office start + grace before absent monitor may alert (false-positive guard). */
export const ABSENT_MONITOR_EXTRA_GRACE_MINUTES = 5

/** Minimum age of a queued absent row before delivery (allows check-in to land after cron scan). */
export const ABSENT_DELIVERY_MIN_AGE_MS = 90_000

export function ymdBd(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ATTENDANCE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

export function absentDedupeKey(businessId: string, employeeId: string, date = new Date()) {
  return `attendance:absent:${businessId}:${employeeId}:${ymdBd(date)}`
}

export async function findTodayAttendanceForEmployee(input: {
  employeeId: string
  businessId?: string
  attendanceDate?: Date
}) {
  const attendanceDate = input.attendanceDate ?? attendanceDateFor()
  const where = {
    employeeId: input.employeeId,
    attendanceDate,
    ...(input.businessId ? { businessId: input.businessId } : {}),
  }
  return prisma.attendanceRecord.findFirst({
    where,
    orderBy: { checkInAt: 'desc' },
    select: {
      id: true,
      businessId: true,
      employeeId: true,
      checkInAt: true,
      attendanceDate: true,
      createdAt: true,
    },
  })
}

/**
 * Returns true if employee has a committed check-in today for this business,
 * or for any business in their access list (prevents multi-business false absents).
 */
export async function employeePresentForAbsentMonitor(input: {
  employeeId: string
  monitorBusinessId: string
  businessAccess?: string | null
  attendanceDate?: Date
  todayRecordsForBusiness?: Array<{ employeeId: string }>
  globalPresentEmployeeIds?: Set<string>
}) {
  const attendanceDate = input.attendanceDate ?? attendanceDateFor()

  if (input.todayRecordsForBusiness?.some(r => r.employeeId === input.employeeId)) {
    return { present: true, reason: 'business_record' as const }
  }

  if (input.globalPresentEmployeeIds?.has(input.employeeId)) {
    const allowed = parseBusinessAccess(input.businessAccess ?? undefined)
    const record = await findTodayAttendanceForEmployee({ employeeId: input.employeeId, attendanceDate })
    if (record && allowed.includes(record.businessId as never)) {
      return {
        present: true,
        reason: 'cross_business_checkin' as const,
        record,
      }
    }
  }

  const scoped = await findTodayAttendanceForEmployee({
    employeeId: input.employeeId,
    businessId: input.monitorBusinessId,
    attendanceDate,
  })
  if (scoped) {
    return { present: true, reason: 'scoped_recheck' as const, record: scoped }
  }

  return { present: false as const }
}

export async function verifyAbsentBeforeTelegramAlert(input: {
  businessId: string
  employeeId: string
  userId?: string | null
  businessAccess?: string | null
  attendanceDate?: Date
  monitorScanAt?: Date
}) {
  const attendanceDate = input.attendanceDate ?? attendanceDateFor()
  const scanAt = input.monitorScanAt ?? new Date()

  let businessAccess = input.businessAccess
  if (!businessAccess && input.userId) {
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { businessAccess: true, active: true, employeeIdGas: true },
    })
    if (!user?.active) {
      return { allow: false, reason: 'employee_inactive', blocked: true as const }
    }
    businessAccess = user.businessAccess
    if (user.employeeIdGas && user.employeeIdGas !== input.employeeId) {
      return { allow: false, reason: 'employee_id_mismatch', blocked: true as const }
    }
  }

  if (!userHasBusinessAccess(businessAccess, input.businessId)) {
    return { allow: false, reason: 'business_scope_mismatch', blocked: true as const }
  }

  const presence = await employeePresentForAbsentMonitor({
    employeeId: input.employeeId,
    monitorBusinessId: input.businessId,
    businessAccess,
    attendanceDate,
  })

  if (presence.present) {
    return {
      allow: false,
      reason: presence.reason,
      blocked: true as const,
      record: 'record' in presence ? presence.record : undefined,
    }
  }

  return { allow: true, blocked: false as const, monitorScanAt: scanAt }
}

export async function suppressStaleAbsentAlertsForCheckIn(record: AttendanceRecord) {
  const user = record.userId
    ? await prisma.user.findUnique({
        where: { id: record.userId },
        select: { businessAccess: true },
      })
    : await prisma.user.findFirst({
        where: { employeeIdGas: record.employeeId },
        select: { businessAccess: true },
      })

  const businesses = new Set<string>([
    record.businessId,
    ...parseBusinessAccess(user?.businessAccess),
  ])

  const keys = [...businesses].map(biz => absentDedupeKey(biz, record.employeeId, record.attendanceDate))

  const updated = await prisma.telegramNotificationQueue.updateMany({
    where: {
      eventType: 'ATTENDANCE_ABSENT',
      status: { in: ['QUEUED', 'FAILED', 'SENDING'] },
      OR: keys.map(dedupeKey => ({ dedupeKey })),
    },
    data: {
      status: 'SKIPPED',
      errorMessage: 'superseded_by_checkin',
      nextAttemptAt: null,
    },
  })

  if (updated.count > 0) {
    logEvent('info', 'attendance.false_positive_blocked', {
      employeeId: record.employeeId,
      businessId: record.businessId,
      attendanceRecordId: record.id,
      suppressedQueueRows: updated.count,
      checkInAt: record.checkInAt.toISOString(),
    })
  }

  return { suppressed: updated.count, dedupeKeys: keys }
}

export function absentDeliveryAgeOk(queuedAt: Date, now = new Date()) {
  return now.getTime() - queuedAt.getTime() >= ABSENT_DELIVERY_MIN_AGE_MS
}
