import type { AttendanceRecord } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { localMinutesFor } from '@/lib/attendance'
import {
  attendanceDeepLink,
  businessLabel,
  formatAbsentAlert,
  formatCheckInAlert,
  formatCheckOutAlert,
  formatEarlyLeaveAlert,
  formatNoCheckoutAlert,
  formatOfficeStart,
  formatSuspiciousCheckInAlert,
} from '@/lib/telegram-notification/formatters'
import { withEmployeeAvatarMetadata } from '@/lib/telegram-notification/enqueue-metadata'
import { scheduleTelegramNotificationAndFlush } from '@/lib/telegram-notification/queue'
import { getTelegramOpsSetting, shouldSendLateDetail } from '@/lib/telegram-notification/settings'
import { logTelegramOpsAudit } from '@/lib/telegram-ops-audit'
import {
  ABSENT_MONITOR_EXTRA_GRACE_MINUTES,
  absentDedupeKey,
  verifyAbsentBeforeTelegramAlert,
  ymdBd,
} from '@/lib/attendance-absent-safety'
import { logEvent } from '@/lib/logger'

async function loadEmployeeContext(userId: string | null, employeeId: string) {
  const user = userId
    ? await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, phone: true },
      })
    : await prisma.user.findFirst({
        where: { employeeIdGas: employeeId },
        select: { id: true, name: true, phone: true },
      })
  return {
    userId: user?.id || userId,
    name: user?.name || employeeId,
    phone: user?.phone ?? null,
  }
}

export async function queueAttendanceCheckInAlert(record: AttendanceRecord) {
  if (record.faceVerified) {
    const { notifyFaceVerifiedCheckIn } = await import('@/lib/telegram-notification/face-checkin-notify')
    return notifyFaceVerifiedCheckIn(record)
  }

  const setting = await getTelegramOpsSetting(record.businessId)
  if (!setting.alertAttendanceCheckIn) return

  const employee = await loadEmployeeContext(record.userId, record.employeeId)
  const department = businessLabel(record.businessId)
  const link = attendanceDeepLink(record.businessId, record.employeeId)
  const lateMinutes = record.lateMinutes
  const showLate = lateMinutes > 0 && shouldSendLateDetail(setting)

  const message = formatCheckInAlert({
    employeeName: employee.name,
    department,
    checkInAt: record.checkInAt,
    lateMinutes: showLate ? lateMinutes : 0,
    phone: employee.phone,
    erpLink: link,
  })

  const dedupeKey = `attendance:checkin:${record.businessId}:${record.employeeId}:${ymdBd(record.checkInAt)}`

  scheduleTelegramNotificationAndFlush({
    businessId: record.businessId,
    eventType: 'ATTENDANCE_CHECK_IN',
    message,
    dedupeKey,
    metadata: withEmployeeAvatarMetadata(
      { attendanceRecordId: record.id, employeeId: record.employeeId },
      employee.userId || record.userId,
      employee.name,
    ),
  })

  await logTelegramOpsAudit({
    businessId: record.businessId,
    eventType: 'TELEGRAM_CHECK_IN_QUEUED',
    employeeId: record.employeeId,
    attendanceRecordId: record.id,
    detail: `lateMinutes=${lateMinutes}`,
  })

  if (
    setting.alertAttendanceSuspicious &&
    (record.trustStatus !== 'TRUSTED' || record.verificationRequired)
  ) {
    const reasons = record.suspiciousReasons?.length
      ? record.suspiciousReasons
      : [record.trustStatus]
    scheduleTelegramNotificationAndFlush({
      businessId: record.businessId,
      eventType: 'ATTENDANCE_SUSPICIOUS',
      message: formatSuspiciousCheckInAlert({
        employeeName: employee.name,
        reasons,
        checkInAt: record.checkInAt,
        erpLink: link,
      }),
      dedupeKey: `attendance:suspicious:${record.id}`,
      metadata: withEmployeeAvatarMetadata(
        { attendanceRecordId: record.id },
        employee.userId || record.userId,
        employee.name,
      ),
    })
  }
}

export async function queueAttendanceCheckOutAlert(
  record: AttendanceRecord & { checkOutAt: Date },
  options?: { earlyLeave?: boolean },
) {
  const setting = await getTelegramOpsSetting(record.businessId)
  const link = attendanceDeepLink(record.businessId, record.employeeId)
  const employee = await loadEmployeeContext(record.userId, record.employeeId)
  const worked = record.totalWorkMinutes

  if (setting.alertAttendanceCheckOut) {
    scheduleTelegramNotificationAndFlush({
      businessId: record.businessId,
      eventType: 'ATTENDANCE_CHECK_OUT',
      message: formatCheckOutAlert({
        employeeName: employee.name,
        checkOutAt: record.checkOutAt,
        totalWorkMinutes: worked,
        erpLink: link,
      }),
      dedupeKey: `attendance:checkout:${record.id}`,
      metadata: withEmployeeAvatarMetadata(
        { attendanceRecordId: record.id },
        employee.userId || record.userId,
        employee.name,
      ),
    })
  }

  const isEarly =
    options?.earlyLeave ??
    (worked > 0 && worked < setting.earlyLeaveMinutes)

  if (isEarly && setting.alertAttendanceEarlyLeave) {
    scheduleTelegramNotificationAndFlush({
      businessId: record.businessId,
      eventType: 'ATTENDANCE_EARLY_LEAVE',
      message: formatEarlyLeaveAlert({
        employeeName: employee.name,
        workedMinutes: worked,
        erpLink: link,
      }),
      dedupeKey: `attendance:early:${record.id}`,
      metadata: withEmployeeAvatarMetadata(
        { attendanceRecordId: record.id },
        employee.userId || record.userId,
        employee.name,
      ),
    })
  }

  await logTelegramOpsAudit({
    businessId: record.businessId,
    eventType: 'TELEGRAM_CHECK_OUT_QUEUED',
    employeeId: record.employeeId,
    attendanceRecordId: record.id,
    detail: `worked=${worked}; early=${Boolean(isEarly)}`,
  })
}

export async function queueAttendanceAbsentAlert(input: {
  businessId: string
  userId?: string | null
  employeeId: string
  employeeName: string
  phone: string | null
  officeStartMinutes: number
  delayMinutes: number
  monitorScanAt?: Date
}): Promise<{ queued: boolean; blocked?: boolean; reason?: string }> {
  const verification = await verifyAbsentBeforeTelegramAlert({
    businessId: input.businessId,
    employeeId: input.employeeId,
    userId: input.userId,
    monitorScanAt: input.monitorScanAt,
  })

  if (!verification.allow) {
    logEvent('info', 'attendance.false_positive_blocked', {
      businessId: input.businessId,
      employeeId: input.employeeId,
      reason: verification.reason,
      phase: 'enqueue',
    })
    return { queued: false, blocked: true, reason: verification.reason }
  }

  const message = formatAbsentAlert({
    employeeName: input.employeeName,
    department: businessLabel(input.businessId),
    officeStartLabel: formatOfficeStart(input.officeStartMinutes),
    delayMinutes: input.delayMinutes,
    phone: input.phone,
    attendanceStatus: 'No check-in recorded',
    erpLink: attendanceDeepLink(input.businessId, input.employeeId),
  })

  scheduleTelegramNotificationAndFlush({
    businessId: input.businessId,
    eventType: 'ATTENDANCE_ABSENT',
    message,
    dedupeKey: absentDedupeKey(input.businessId, input.employeeId),
    metadata: withEmployeeAvatarMetadata(
      {
        employeeId: input.employeeId,
        monitorScanAt: (input.monitorScanAt ?? new Date()).toISOString(),
      },
      input.userId,
      input.employeeName,
    ),
  })

  return { queued: true }
}

export async function queueAttendanceNoCheckoutAlert(input: {
  businessId: string
  userId?: string | null
  employeeId: string
  employeeName: string
  checkInAt: Date
  lastActivityAt: Date | null
  attendanceRecordId: string
}) {
  scheduleTelegramNotificationAndFlush({
    businessId: input.businessId,
    eventType: 'ATTENDANCE_NO_CHECKOUT',
    message: formatNoCheckoutAlert({
      employeeName: input.employeeName,
      checkInAt: input.checkInAt,
      lastActivityAt: input.lastActivityAt,
      erpLink: attendanceDeepLink(input.businessId, input.employeeId),
    }),
    dedupeKey: `attendance:nocheckout:${input.businessId}:${input.employeeId}:${ymdBd()}`,
    metadata: withEmployeeAvatarMetadata(
      { attendanceRecordId: input.attendanceRecordId },
      input.userId,
      input.employeeName,
    ),
  })
}

/** Used by monitor — office start + grace in BD local minutes. */
export function attendanceMonitorThresholdMinutes(officeStartMinutes: number, gracePeriodMinutes: number) {
  return officeStartMinutes + gracePeriodMinutes
}

export function isPastAbsentThreshold(
  officeStartMinutes: number,
  gracePeriodMinutes: number,
  now = new Date(),
) {
  return (
    localMinutesFor(now)
    >= attendanceMonitorThresholdMinutes(officeStartMinutes, gracePeriodMinutes)
      + ABSENT_MONITOR_EXTRA_GRACE_MINUTES
  )
}

export function isPastCheckoutCutoff(checkoutCutoffMinutes: number, now = new Date()) {
  return localMinutesFor(now) >= checkoutCutoffMinutes
}
