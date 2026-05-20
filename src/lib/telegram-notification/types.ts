import type { TelegramNotificationEventType } from '@prisma/client'

export type { TelegramNotificationEventType }

export type EnqueueTelegramNotificationInput = {
  businessId: string
  eventType: TelegramNotificationEventType
  message: string
  dedupeKey?: string
  metadata?: Record<string, unknown>
  /** Override recipient chats; default resolves owner chat IDs from settings. */
  chatIds?: string[]
}

export type TelegramOpsSettingDto = {
  businessId: string
  enabled: boolean
  ownerChatIds: string
  officeStartMinutes: number
  gracePeriodMinutes: number
  checkoutCutoffMinutes: number
  earlyLeaveMinutes: number
  alertAttendanceCheckIn: boolean
  alertAttendanceLate: boolean
  alertAttendanceAbsent: boolean
  alertAttendanceCheckOut: boolean
  alertAttendanceNoCheckout: boolean
  alertAttendanceEarlyLeave: boolean
  alertAttendanceSuspicious: boolean
  alertTradingScreenshot: boolean
  alertTradingDeleteRequest: boolean
  alertWorkflowLifecycle: boolean
  alertOpsDailySummary: boolean
}
