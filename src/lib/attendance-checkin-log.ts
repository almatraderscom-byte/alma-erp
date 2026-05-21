import { logEvent } from '@/lib/logger'

export type AttendanceCheckinLogMeta = {
  requestId?: string
  userId?: string
  employeeId?: string
  businessId?: string
  attendanceDate?: string
  latencyMs?: number
  environment?: string
  deviceType?: string
  duplicate?: boolean
  attendanceRecordId?: string
  reason?: string
  message?: string
}

function base(meta: AttendanceCheckinLogMeta) {
  return {
    requestId: meta.requestId,
    userId: meta.userId,
    employeeId: meta.employeeId,
    businessId: meta.businessId,
    attendanceDate: meta.attendanceDate,
    latencyMs: meta.latencyMs,
    environment: meta.environment ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    deviceType: meta.deviceType,
    attendanceRecordId: meta.attendanceRecordId,
    duplicate: meta.duplicate,
    reason: meta.reason,
    message: meta.message,
  }
}

export function logAttendanceCheckinRequested(meta: AttendanceCheckinLogMeta) {
  // Dual emit: `started` matches the canonical Sentry instrumentation contract,
  // `requested` is the legacy name used by existing dashboards.
  logEvent('info', 'attendance.checkin.started', base(meta))
  logEvent('info', 'attendance.checkin.requested', base(meta))
}

export function logAttendanceCheckinValidationFailed(meta: AttendanceCheckinLogMeta) {
  logEvent('warn', 'attendance.checkin.validation_failed', base(meta))
}

export function logAttendanceCheckinTransactionStarted(meta: AttendanceCheckinLogMeta) {
  logEvent('info', 'attendance.checkin.transaction_started', base(meta))
}

export function logAttendanceCheckinTransactionCommitted(meta: AttendanceCheckinLogMeta) {
  // Dual emit: `persisted` matches the canonical Sentry instrumentation contract.
  logEvent('info', 'attendance.checkin.persisted', base(meta))
  logEvent('info', 'attendance.checkin.transaction_committed', base(meta))
}

export function logAttendanceCheckinTransactionFailed(meta: AttendanceCheckinLogMeta) {
  // Dual emit for parity with Sentry critical-event patterns.
  logEvent('error', 'attendance.checkin.failed', base(meta))
  logEvent('error', 'attendance.checkin.transaction_failed', base(meta))
}

export function logAttendanceCheckinResponseSent(meta: AttendanceCheckinLogMeta) {
  logEvent('info', 'attendance.checkin.response_sent', base(meta))
}

export function logAttendanceCheckinDuplicateBlocked(meta: AttendanceCheckinLogMeta) {
  logEvent('warn', 'attendance.checkin.duplicate_blocked', base(meta))
}

export function logAttendanceCheckinSideEffectFailed(meta: AttendanceCheckinLogMeta & { sideEffect: string }) {
  logEvent('warn', 'attendance.checkin.side_effect_failed', { ...base(meta), sideEffect: meta.sideEffect })
  if (meta.sideEffect === 'telegram_face') {
    logEvent('warn', 'attendance.telegram_event_missing', {
      ...base(meta),
      sideEffect: meta.sideEffect,
      stage: 'check_in_notify',
    })
  }
}

export function logAttendanceCheckinTelegramQueued(meta: AttendanceCheckinLogMeta & {
  queueIds?: string[]
  rowCount?: number
}) {
  // Canonical Sentry contract name; complements existing `attendance.telegram.enqueued`.
  logEvent('info', 'attendance.checkin.telegram_queued', {
    ...base(meta),
    queueIds: meta.queueIds,
    rowCount: meta.rowCount,
  })
}

export function logAttendanceCheckinTelegramSent(meta: AttendanceCheckinLogMeta & {
  queueId?: string
  latencyMs?: number
}) {
  logEvent('info', 'attendance.checkin.telegram_sent', {
    ...base(meta),
    queueId: meta.queueId,
    latencyMs: meta.latencyMs,
  })
}

export function logAttendanceCheckinCaptureCreated(meta: AttendanceCheckinLogMeta) {
  logEvent('info', 'attendance.checkin.capture_created', base(meta))
}
