import { logEvent } from '@/lib/logger'

export type AttendancePhotoLogMeta = {
  requestId?: string
  userId?: string
  employeeId?: string
  businessId?: string
  attendanceRecordId?: string
  storagePath?: string
  bucket?: string
  sizeBytes?: number
  message?: string
  reason?: string
  latencyMs?: number
}

function base(meta: AttendancePhotoLogMeta) {
  return {
    requestId: meta.requestId,
    userId: meta.userId,
    employeeId: meta.employeeId,
    businessId: meta.businessId,
    attendanceRecordId: meta.attendanceRecordId,
    storagePath: meta.storagePath,
    bucket: meta.bucket,
    sizeBytes: meta.sizeBytes,
    message: meta.message,
    reason: meta.reason,
    latencyMs: meta.latencyMs,
  }
}

export function logAttendancePhotoUploadStarted(meta: AttendancePhotoLogMeta) {
  logEvent('info', 'attendance.photo.upload_started', base(meta))
}

export function logAttendancePhotoUploadSuccess(meta: AttendancePhotoLogMeta) {
  logEvent('info', 'attendance.photo.upload_success', base(meta))
}

export function logAttendancePhotoUploadFailed(meta: AttendancePhotoLogMeta) {
  logEvent('warn', 'attendance.photo.upload_failed', base(meta))
}

export function logAttendancePhotoFileMissing(meta: AttendancePhotoLogMeta) {
  logEvent('warn', 'attendance.photo.file_missing', base(meta))
}

export function logAttendancePhotoIntegrityFailed(meta: AttendancePhotoLogMeta) {
  logEvent('warn', 'attendance.photo.integrity_failed', base(meta))
}
