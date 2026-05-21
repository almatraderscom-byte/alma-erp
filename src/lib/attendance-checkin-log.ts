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
  logEvent('info', 'attendance.checkin.requested', base(meta))
}

export function logAttendanceCheckinValidationFailed(meta: AttendanceCheckinLogMeta) {
  logEvent('warn', 'attendance.checkin.validation_failed', base(meta))
}

export function logAttendanceCheckinTransactionStarted(meta: AttendanceCheckinLogMeta) {
  logEvent('info', 'attendance.checkin.transaction_started', base(meta))
}

export function logAttendanceCheckinTransactionCommitted(meta: AttendanceCheckinLogMeta) {
  logEvent('info', 'attendance.checkin.transaction_committed', base(meta))
}

export function logAttendanceCheckinTransactionFailed(meta: AttendanceCheckinLogMeta) {
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
}
