import {
  AttendanceClientError,
  mapAttendanceHttpError,
  type AttendanceApiErrorBody,
  type AttendanceErrorCode,
} from '@/lib/attendance-errors'
import { normalizeMyAttendancePayload } from '@/lib/attendance-portal-normalize'
import { readApiError, unwrapApiData } from '@/lib/safe-api-response'
import { safeFetchJson } from '@/lib/safe-fetch'

export { AttendanceClientError } from '@/lib/attendance-errors'

export type MyAttendancePayload = {
  businessId?: string
  employeeId?: string | null
  needsEmployeeLink?: boolean
  systemOwner?: boolean
  today: AttendanceRecordClient | null
  records: AttendanceRecordClient[]
  waivers: AttendanceWaiverClient[]
  summary: {
    presentDays: number
    lateCount: number
    totalPenalties: number
    waivedPenalties: number
    averageWorkMinutes: number
  }
}

export type AttendanceRecordClient = {
  id: string
  attendanceDate: string
  checkInAt: string
  checkOutAt: string | null
  totalWorkMinutes: number
  lateMinutes: number
  penaltyAmount: number
  trustStatus: string
  suspiciousReasons: string[]
  verificationRequired: boolean
  faceVerified: boolean
  faceVerifiedAt: string | null
  selfieCount: number
  waiverRequests: AttendanceWaiverClient[]
}

export type AttendanceWaiverClient = {
  id: string
  status: string
  statusLabel?: string
  requestType?: string
  reason: string
  originalPenaltyAmount: number
  requestedReductionAmount: number | null
  approvedReductionAmount: number | null
  finalAppliedPenalty?: number
  hasAttachment?: boolean
  adminNote?: string | null
  createdAt: string
}

const ATTENDANCE_FETCH_TIMEOUT_MS = 25_000

function deviceContext() {
  if (typeof navigator === 'undefined') return {}
  return {
    online: navigator.onLine,
    visibility: typeof document !== 'undefined' ? document.visibilityState : 'unknown',
    userAgent: navigator.userAgent.slice(0, 120),
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchMyAttendance(businessId: string): Promise<MyAttendancePayload> {
  const url = `/api/attendance?business_id=${encodeURIComponent(businessId)}&scope=me`
  const result = await safeFetchJson<MyAttendancePayload>(url, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    timeoutMs: ATTENDANCE_FETCH_TIMEOUT_MS,
  })

  if (!result.ok) {
    const err = result.error
    const code = (err.code?.toUpperCase().replace(/-/g, '_') || 'NETWORK') as AttendanceErrorCode
    const mapped = mapAttendanceHttpError(result.status, {
      code,
      error: err.message,
      message: err.message,
      retryable: result.rolledBack,
    } as AttendanceApiErrorBody)
    throw new AttendanceClientError(mapped.code, mapped.message, result.status, mapped.retryable)
  }

  const raw = unwrapApiData<Record<string, unknown>>(result.data as Record<string, unknown>)
  return normalizeMyAttendancePayload(raw)
}

export function attendanceErrorLabel(code: AttendanceErrorCode): string {
  switch (code) {
    case 'UNAUTHORIZED':
      return 'Session expired'
    case 'NEEDS_EMPLOYEE_LINK':
      return 'Profile not linked'
    case 'SCHEMA_OUTDATED':
      return 'Server updating'
    case 'DB_UNAVAILABLE':
      return 'Server busy'
    case 'NETWORK':
    case 'TIMEOUT':
      return 'Connection issue'
    default:
      return 'Error'
  }
}

export function logAttendanceClientFailure(event: string, meta: Record<string, unknown>) {
  if (typeof window === 'undefined') return
  console.warn(
    JSON.stringify({
      level: 'warn',
      event,
      surface: 'attendance-client',
      timestamp: new Date().toISOString(),
      ...deviceContext(),
      ...meta,
    }),
  )
}

export function logAttendanceClientSuccess(event: string, meta: Record<string, unknown>) {
  if (typeof window === 'undefined') return
  console.info(
    JSON.stringify({
      level: 'info',
      event,
      surface: 'attendance-client',
      timestamp: new Date().toISOString(),
      ...deviceContext(),
      ...meta,
    }),
  )
}
