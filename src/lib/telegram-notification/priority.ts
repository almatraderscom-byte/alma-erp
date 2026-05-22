import type { TelegramNotificationEventType } from '@prisma/client'

export type TelegramDeliveryPriority = 'HIGH' | 'LOW'

/** High-priority alerts process first; low-priority may wait 45s before first attempt. */
const HIGH_PRIORITY_EVENTS = new Set<TelegramNotificationEventType>([
  'ATTENDANCE_CHECK_IN',
  'ATTENDANCE_FACE_VERIFIED_CHECK_IN',
  'ATTENDANCE_CHECK_OUT',
  'ATTENDANCE_WAIVER_SUBMITTED',
  'ATTENDANCE_WAIVER_REVIEWED',
  'ATTENDANCE_SUSPICIOUS',
  'ATTENDANCE_ABSENT',
  'PAYROLL_WALLET_REQUEST',
  'WORKFLOW_SUBMITTED',
  'WORKFLOW_APPROVED',
  'WORKFLOW_REJECTED',
  'TRADING_DELETE_REQUEST',
  'TRADING_SUSPICIOUS',
])

const LOW_PRIORITY_DELAY_MS = 45_000

export function telegramEventPriority(eventType: TelegramNotificationEventType): TelegramDeliveryPriority {
  if (HIGH_PRIORITY_EVENTS.has(eventType)) return 'HIGH'
  if (eventType === 'TRADING_SCREENSHOT_UPLOAD' || eventType === 'OPS_DAILY_SUMMARY') return 'LOW'
  if (eventType.startsWith('OPERATIONAL_TASK_')) return 'LOW'
  return 'HIGH'
}

export function lowPriorityInitialDelay(eventType: TelegramNotificationEventType): Date | null {
  if (telegramEventPriority(eventType) !== 'LOW') return null
  return new Date(Date.now() + LOW_PRIORITY_DELAY_MS)
}

export function compareTelegramQueueRows<
  T extends { eventType: TelegramNotificationEventType; createdAt: Date },
>(a: T, b: T): number {
  const pa = telegramEventPriority(a.eventType) === 'HIGH' ? 0 : 1
  const pb = telegramEventPriority(b.eventType) === 'HIGH' ? 0 : 1
  if (pa !== pb) return pa - pb
  return a.createdAt.getTime() - b.createdAt.getTime()
}

/** Map DB status to ops dashboard vocabulary. */
export function mapTelegramQueueStatus(status: string): string {
  switch (status) {
    case 'QUEUED':
      return 'PENDING'
    case 'SENDING':
      return 'PROCESSING'
    case 'SENT':
      return 'DELIVERED'
    case 'FAILED':
      return 'FAILED'
    case 'SKIPPED':
      return 'SKIPPED'
    default:
      return status
  }
}

export function isRetryWaitRow(row: {
  status: string
  nextAttemptAt: Date | null
  attempts: number
  maxAttempts: number
}): boolean {
  return row.status === 'QUEUED' && row.nextAttemptAt != null && row.attempts > 0
}
