import type { TelegramNotificationEventType, TelegramOpsSetting } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { BusinessId } from '@/lib/businesses'
import type { TelegramOpsSettingDto } from '@/lib/telegram-notification/types'
import {
  envOwnerChatIdsRaw,
  normalizeOwnerChatIds,
  parseOwnerChatIdsFromRaw,
  resolveOwnerChatIds,
  resolveOwnerChatIdsWithMeta,
} from '@/lib/telegram-notification/owner-routing'

export {
  envOwnerChatIdsRaw,
  normalizeOwnerChatIds,
  parseOwnerChatIdsFromRaw,
  resolveOwnerChatIds,
  resolveOwnerChatIdsWithMeta,
}

/** Display helper: union of DB + env IDs (not used for delivery routing). */
export function parseOwnerChatIds(raw: string | null | undefined): string[] {
  const fromSetting = parseOwnerChatIdsFromRaw(raw)
  const fromEnv = parseOwnerChatIdsFromRaw(envOwnerChatIdsRaw())
  return [...new Set([...fromSetting, ...fromEnv])]
}

export function telegramOpsSettingDto(row: TelegramOpsSetting): TelegramOpsSettingDto {
  return {
    businessId: row.businessId,
    enabled: row.enabled,
    ownerChatIds: row.ownerChatIds,
    officeStartMinutes: row.officeStartMinutes,
    gracePeriodMinutes: row.gracePeriodMinutes,
    checkoutCutoffMinutes: row.checkoutCutoffMinutes,
    earlyLeaveMinutes: row.earlyLeaveMinutes,
    alertAttendanceCheckIn: row.alertAttendanceCheckIn,
    alertAttendanceLate: row.alertAttendanceLate,
    alertAttendanceAbsent: row.alertAttendanceAbsent,
    alertAttendanceCheckOut: row.alertAttendanceCheckOut,
    alertAttendanceNoCheckout: row.alertAttendanceNoCheckout,
    alertAttendanceEarlyLeave: row.alertAttendanceEarlyLeave,
    alertAttendanceSuspicious: row.alertAttendanceSuspicious,
    alertTradingScreenshot: row.alertTradingScreenshot,
    alertTradingDeleteRequest: row.alertTradingDeleteRequest,
    alertWorkflowLifecycle: row.alertWorkflowLifecycle,
    alertOpsDailySummary: row.alertOpsDailySummary,
  }
}

export async function getTelegramOpsSetting(businessId: string): Promise<TelegramOpsSetting> {
  const existing = await prisma.telegramOpsSetting.findUnique({ where: { businessId } })
  if (existing) return existing
  return prisma.telegramOpsSetting.create({
    data: { businessId },
  })
}

export function eventTypeEnabled(
  setting: TelegramOpsSetting,
  eventType: TelegramNotificationEventType,
): boolean {
  if (!setting.enabled) return false
  switch (eventType) {
    case 'ATTENDANCE_CHECK_IN':
    case 'ATTENDANCE_FACE_VERIFIED_CHECK_IN':
      return setting.alertAttendanceCheckIn
    case 'ATTENDANCE_CHECK_OUT':
      return setting.alertAttendanceCheckOut
    case 'ATTENDANCE_ABSENT':
      return setting.alertAttendanceAbsent
    case 'ATTENDANCE_NO_CHECKOUT':
      return setting.alertAttendanceNoCheckout
    case 'ATTENDANCE_EARLY_LEAVE':
      return setting.alertAttendanceEarlyLeave
    case 'ATTENDANCE_SUSPICIOUS':
      return setting.alertAttendanceSuspicious
    case 'ATTENDANCE_WAIVER_SUBMITTED':
    case 'ATTENDANCE_WAIVER_REVIEWED':
      return setting.alertAttendanceLate
    case 'TRADING_SCREENSHOT_UPLOAD':
    case 'TRADING_SCREENSHOT_FAILURE':
      return setting.alertTradingScreenshot
    case 'TRADING_DELETE_REQUEST':
    case 'TRADING_SUSPICIOUS':
    case 'PAYROLL_WALLET_REQUEST':
      return setting.alertTradingDeleteRequest
    case 'WORKFLOW_SUBMITTED':
    case 'WORKFLOW_APPROVED':
    case 'WORKFLOW_REJECTED':
      return setting.alertWorkflowLifecycle
    case 'OPS_DAILY_SUMMARY':
      return setting.alertOpsDailySummary
    default:
      return true
  }
}

export function shouldSendLateDetail(setting: TelegramOpsSetting): boolean {
  return setting.alertAttendanceLate
}

export async function upsertTelegramOpsSetting(
  businessId: BusinessId,
  patch: Partial<TelegramOpsSettingDto> & { updatedById?: string },
): Promise<TelegramOpsSettingDto> {
  const row = await prisma.telegramOpsSetting.upsert({
    where: { businessId },
    create: {
      businessId,
      ...patch,
    },
    update: {
      ...patch,
      updatedById: patch.updatedById,
    },
  })
  return telegramOpsSettingDto(row)
}
