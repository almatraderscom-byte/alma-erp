import { logEvent } from '@/lib/logger'
import { captureException } from '@/lib/sentry/capture'

export type AttendanceWidgetCrashMeta = {
  message?: string
  stack?: string
  component?: string
  hook?: string
  property?: string
  pathname?: string
  userId?: string
  businessId?: string
  employeeId?: string
  pwa?: boolean
  ios?: boolean
  safari?: boolean
  hydrationState?: string
  payloadDigest?: string
  componentStack?: string
}

function deviceFlags() {
  if (typeof navigator === 'undefined') return {}
  const ua = navigator.userAgent
  const ios = /iphone|ipad|ipod/i.test(ua)
  const safari = ios && /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua)
  const pwa =
    typeof window !== 'undefined'
    && (window.matchMedia('(display-mode: standalone)').matches
      || (window.navigator as Navigator & { standalone?: boolean }).standalone === true)
  return { ios, safari, pwa, mobile: ios || /android/i.test(ua) }
}

export function logAttendanceWidgetRuntimeCrash(
  error: Error,
  meta: AttendanceWidgetCrashMeta = {},
) {
  const payload = {
    ...deviceFlags(),
    ...meta,
    message: error.message,
    stack: error.stack?.split('\n').slice(0, 12).join('\n'),
  }
  logEvent('error', 'attendance.widget.runtime_crash', payload)
  void captureException(error, {
    category: 'client',
    event: 'attendance.widget.runtime_crash',
    critical: true,
    extra: payload,
  })
  if (typeof window !== 'undefined') {
    try {
      const key = 'alma_attendance_last_crash'
      sessionStorage.setItem(
        key,
        JSON.stringify({ ...payload, at: new Date().toISOString() }).slice(0, 4000),
      )
    } catch {
      // ignore quota
    }
  }
}
