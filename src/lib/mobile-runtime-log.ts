import { logEvent } from '@/lib/logger'
import { captureException } from '@/lib/sentry/capture'

export type MobileRuntimeContext = {
  userId?: string
  businessId?: string
  pathname?: string
  mobile?: boolean
  ios?: boolean
  android?: boolean
  pwa?: boolean
  hydrationState?: string
  component?: string
  api?: string
  fetchStatus?: number
  sessionStatus?: string
  provider?: string
  buildId?: string
  message?: string
  digest?: string
}

function detectMobileFlags() {
  if (typeof navigator === 'undefined') {
    return { mobile: false, ios: false, android: false, pwa: false }
  }
  const ua = navigator.userAgent
  const ios = /iphone|ipad|ipod/i.test(ua)
  const android = /android/i.test(ua)
  const mobile = ios || android || /mobile/i.test(ua)
  const pwa =
    typeof window !== 'undefined'
    && (window.matchMedia('(display-mode: standalone)').matches
      || (window.navigator as Navigator & { standalone?: boolean }).standalone === true)
  return { mobile, ios, android, pwa }
}

export function readMobileRuntimeContext(extra: MobileRuntimeContext = {}): MobileRuntimeContext {
  const flags = detectMobileFlags()
  const buildId =
    typeof process !== 'undefined'
      ? process.env.NEXT_PUBLIC_APP_BUILD_ID || process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT || ''
      : ''
  return {
    ...flags,
    buildId: buildId || extra.buildId,
    ...extra,
  }
}

export function logRuntimeMobileCrash(meta: MobileRuntimeContext & { error?: Error }) {
  const payload = readMobileRuntimeContext(meta)
  logEvent('error', 'runtime.mobile_crash', payload)
  if (meta.error) {
    void captureException(meta.error, {
      category: 'client',
      event: 'runtime.mobile_crash',
      critical: true,
      extra: payload,
    })
  }
}

export function logAttendanceMobileSubmitFailed(meta: Record<string, unknown>) {
  logEvent('warn', 'attendance.mobile_submit_failed', readMobileRuntimeContext(meta))
}

export function logAttendanceTelegramEventMissing(meta: Record<string, unknown>) {
  logEvent('warn', 'attendance.telegram_event_missing', readMobileRuntimeContext(meta))
}
