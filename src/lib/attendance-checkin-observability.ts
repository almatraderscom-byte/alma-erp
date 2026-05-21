import { logEvent } from '@/lib/logger'

export type AttendanceCheckinOutcome = 'success' | 'duplicate' | 'validation_failed' | 'transaction_failed'

export type AttendanceCheckinMetricMeta = {
  requestId?: string
  userId?: string
  employeeId?: string
  businessId?: string
  attendanceDate?: string
  deviceType?: string
  outcome: AttendanceCheckinOutcome
  /** Wall-clock ms for the HTTP handler through response. */
  latencyMs?: number
  /** Time inside prisma.$transaction only. */
  transactionMs?: number
  duplicate?: boolean
  timeout?: boolean
  retry?: boolean
  mobile?: boolean
  sideEffectFailures?: string[]
  penaltyAmount?: number
  attendanceRecordId?: string
}

/** Per-request metric line for log aggregators (BetterStack / Sentry). */
export function recordAttendanceCheckinMetric(meta: AttendanceCheckinMetricMeta) {
  logEvent('info', 'attendance.health.metric', {
    ...meta,
    success: meta.outcome === 'success' || meta.outcome === 'duplicate',
  })
}

/** Human-readable rollup emitted after each completed check-in response. */
export function logAttendanceHealthSummary(meta: AttendanceCheckinMetricMeta & {
  todayCheckIns?: number
  todayDuplicates?: number
}) {
  logEvent('info', 'attendance.health.summary', {
    checkInSuccessRate: meta.outcome === 'success' || meta.outcome === 'duplicate' ? 1 : 0,
    averageLatencyMs: meta.latencyMs,
    transactionMs: meta.transactionMs,
    duplicateBlocked: meta.outcome === 'duplicate' ? 1 : 0,
    timeoutCount: meta.timeout ? 1 : 0,
    retryCount: meta.retry ? 1 : 0,
    telegramSideEffectFailures: meta.sideEffectFailures?.filter(s => s.startsWith('telegram')).length ?? 0,
    transactionFailures: meta.outcome === 'transaction_failed' ? 1 : 0,
    mobileFailures: meta.mobile && meta.outcome === 'transaction_failed' ? 1 : 0,
    ...meta,
  })
}
