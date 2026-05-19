import type { AttendanceRecord } from '@prisma/client'
import {
  attendanceDeepLink,
  businessLabel,
  formatFaceVerifiedCheckInAlert,
} from '@/lib/telegram-notification/formatters'
import {
  enqueueTelegramNotification,
  flushTelegramNotificationQueue,
} from '@/lib/telegram-notification/queue'
import { shouldSendLateDetail, getTelegramOpsSetting } from '@/lib/telegram-notification/settings'
import { logTelegramOpsAudit } from '@/lib/telegram-ops-audit'

export { clearLiveFacePhotoForTelegram, stageLiveFacePhotoForTelegram } from '@/lib/telegram-notification/face-photo-staging'

async function loadEmployeeContext(userId: string | null, employeeId: string) {
  const { prisma } = await import('@/lib/prisma')
  const user = userId
    ? await prisma.user.findUnique({ where: { id: userId }, select: { name: true, phone: true } })
    : await prisma.user.findFirst({ where: { employeeIdGas: employeeId }, select: { name: true, phone: true } })
  return { name: user?.name || employeeId, phone: user?.phone ?? null }
}

/**
 * Enqueue + flush face-verified check-in with photo (thumb stored on attendance row).
 * Never throws — attendance must succeed even if Telegram fails.
 */
export async function notifyFaceVerifiedCheckIn(record: AttendanceRecord) {
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
    const enqueued = await enqueueTelegramNotification({
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
      },
    })

    if (!enqueued.ok) {
      console.warn('[telegram-face-checkin] not enqueued', {
        attendanceRecordId: record.id,
        skipped: enqueued.skipped,
      })
      return enqueued
    }

    if (enqueued.duplicate) return enqueued

    let delivered = { processed: 0, results: [] as Array<{ id: string; status: string }> }
    if (enqueued.ids?.length) {
      delivered = await flushTelegramNotificationQueue({
        ids: enqueued.ids,
        limit: enqueued.ids.length,
      })
    }

    await logTelegramOpsAudit({
      businessId: record.businessId,
      eventType: 'FACE_CHECKIN_TELEGRAM',
      employeeId: record.employeeId,
      attendanceRecordId: record.id,
      detail: `rows=${enqueued.ids?.length ?? 0}; sent=${delivered.results.filter(r => r.status === 'SENT').length}`,
    })

    return { ...enqueued, delivered }
  } catch (e) {
    console.error('[telegram-face-checkin] notify failed', {
      attendanceRecordId: record.id,
      message: (e as Error).message,
    })
    return { ok: false, skipped: 'EXCEPTION' }
  }
}
