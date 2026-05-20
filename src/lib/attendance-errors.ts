/** Structured attendance API error codes for client recovery UX. */

export type AttendanceErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NEEDS_EMPLOYEE_LINK'
  | 'SCHEMA_OUTDATED'
  | 'DB_UNAVAILABLE'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'UNKNOWN'

export type AttendanceApiErrorBody = {
  error?: string
  code?: AttendanceErrorCode
  retryable?: boolean
}

export function mapAttendanceHttpError(status: number, body: AttendanceApiErrorBody): {
  code: AttendanceErrorCode
  message: string
  retryable: boolean
} {
  const serverCode = body.code
  const serverMsg = String(body.error || '').trim()

  if (status === 401) {
    return {
      code: 'UNAUTHORIZED',
      message: 'Your session expired. Pull down to refresh or sign in again.',
      retryable: false,
    }
  }
  if (status === 403) {
    return {
      code: 'FORBIDDEN',
      message: serverMsg || 'You do not have permission to view attendance.',
      retryable: false,
    }
  }
  if (status === 503 && (serverCode === 'SCHEMA_OUTDATED' || serverMsg.includes('schema') || serverMsg.includes('migration'))) {
    return {
      code: 'SCHEMA_OUTDATED',
      message: 'Attendance is updating on the server. Try again in one minute.',
      retryable: true,
    }
  }
  if (status === 503 || status === 502 || status === 504) {
    return {
      code: 'DB_UNAVAILABLE',
      message: serverMsg || 'Server is busy. Pull down to retry.',
      retryable: true,
    }
  }
  if (serverCode && serverMsg) {
    return {
      code: serverCode,
      message: serverMsg,
      retryable: Boolean(body.retryable),
    }
  }
  if (serverMsg) {
    return {
      code: status >= 500 ? 'DB_UNAVAILABLE' : 'UNKNOWN',
      message: serverMsg,
      retryable: status >= 500,
    }
  }
  return {
    code: status >= 500 ? 'DB_UNAVAILABLE' : 'UNKNOWN',
    message: status >= 500 ? 'Could not load attendance. Pull down to retry.' : `Request failed (${status})`,
    retryable: status >= 500,
  }
}

export class AttendanceClientError extends Error {
  readonly code: AttendanceErrorCode
  readonly status: number
  readonly retryable: boolean

  constructor(code: AttendanceErrorCode, message: string, status: number, retryable: boolean) {
    super(message)
    this.name = 'AttendanceClientError'
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}
