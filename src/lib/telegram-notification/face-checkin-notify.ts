import type { AttendanceRecord } from '@prisma/client'
import {
  attendanceDeepLink,
  businessLabel,
  formatFaceVerifiedCheckInAlert,
} from '@/lib/telegram-notification/formatters'
import { enqueueTelegramNotification } from '@/lib/telegram-notification/queue'
import { shouldSendLateDetail, getTelegramOpsSetting } from '@/lib/telegram-notification/settings'
import { logTelegramOpsAudit } from '@/lib/telegram-ops-audit'
import { logEvent } from '@/lib/logger'

export { clearLiveFacePhotoForTelegram, stageLiveFacePhotoForTelegram } from '@/lib/telegram-notification/face-photo-staging'

async function loadEmployeeContext(userId: string | null, employeeId: string) {
  const { prisma } = await import('@/lib/prisma')
  const user = userId
    ? await prisma.user.findUnique({ where: { id: userId }, select: { name: true, phone: true } })
    : await prisma.user.findFirst({ where: { employeeIdGas: employeeId }, select: { name: true, phone: true } })
  return { name: user?.name || employeeId, phone: user?.phone ?? null }
}

export type FaceCheckInNotifyResult =
  | { ok: true; queued: true; queueIds: string[] }
  | { ok: false; skipped: string }

/**
 * Persist Telegram queue row for face-verified check-in (awaited DB write).
 * Never throws — attendance HTTP response must not depend on Telegram API success.
 */
export async function notifyFaceVerifiedCheckIn(
  record: AttendanceRecord,
  photo?: { facePhotoBucket: string; facePhotoPath: string },
): Promise<FaceCheckInNotifyResult> {
  const setting = await getTelegramOpsSetting(record.businessId)
  if (!setting.alertAttendanceCheckIn) {
    return { ok: false, skipped: 'EVENT_DISABLED' }
  }

  const employee = await loadEmployeeContext(record.userId, record.employeeId)
  const lateMinutes = record.lateMinutes
  const showLate = lateMinutes > 0 && shouldSendLateDetail(setting)
  const message = formatFaceVerifiedCheckInAlert({
    employeeName: employee.name,
    department: businessLabel(record.businessId),
    checkInAt: record.checkInAt,
    lateMinutes: showLate ? lateMinutes : 0,
    phone: employee.phone,
    erpLink: attendanceDeepLink(record.businessId, record.employeeId),
  })

  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(record.checkInAt)

  try {
    const enqueue = await enqueueTelegramNotification({
      businessId: record.businessId,
      eventType: 'ATTENDANCE_FACE_VERIFIED_CHECK_IN',
      message,
      dedupeKey: `attendance:face:${record.businessId}:${record.employeeId}:${ymd}`,
      metadata: {
        attendanceRecordId: record.id,
        employeeId: record.employeeId,
        userId: record.userId || undefined,
        employeeName: employee.name,
        deliveryMode: 'face_photo',
        facePhotoBucket: photo?.facePhotoBucket,
        facePhotoPath: photo?.facePhotoPath,
      },
    })

    if (!enqueue.ok) {
      logEvent('warn', 'attendance.telegram_event_missing', {
        attendanceRecordId: record.id,
        businessId: record.businessId,
        employeeId: record.employeeId,
        reason: enqueue.skipped || 'enqueue_failed',
      })
      return { ok: false, skipped: enqueue.skipped || 'ENQUEUE_FAILED' }
    }

    const queueIds = enqueue.ids || []
    if (!queueIds.length) {
      return { ok: false, skipped: 'NO_QUEUE_ROWS' }
    }

    logEvent('info', 'attendance.telegram.enqueued', {
      attendanceRecordId: record.id,
      businessId: record.businessId,
      employeeId: record.employeeId,
      rowCount: queueIds.length,
      duplicate: Boolean(enqueue.duplicate),
    })

    void logTelegramOpsAudit({
      businessId: record.businessId,
      eventType: 'FACE_CHECKIN_TELEGRAM',
      employeeId: record.employeeId,
      attendanceRecordId: record.id,
      detail: enqueue.duplicate ? 'queued_duplicate' : 'queued',
    }).catch(() => {})

    return { ok: true, queued: true, queueIds }
  } catch (e) {
    logEvent('warn', 'attendance.telegram_event_missing', {
      attendanceRecordId: record.id,
      message: (e as Error).message,
    })
    console.error('[telegram-face-checkin] notify failed', {
      attendanceRecordId: record.id,
      message: (e as Error).message,
    })
    return { ok: false, skipped: 'EXCEPTION' }
  }
}
