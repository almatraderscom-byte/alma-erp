import type { TelegramNotificationEventType, TelegramOpsSetting } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { BusinessId } from '@/lib/businesses'
import type { TelegramOpsSettingDto } from '@/lib/telegram-notification/types'

const CHAT_ID_RE = /^-?\d{5,20}$/

export function parseOwnerChatIds(raw: string | null | undefined): string[] {
  const fromEnv = (process.env.TELEGRAM_OWNER_CHAT_IDS || '')
    .split(/[,;\n\r]+/)
    .map(s => s.trim())
    .filter(Boolean)
  const fromSetting = (raw || '')
    .split(/[,;\n\r]+/)
    .map(s => s.trim())
    .filter(Boolean)
  return [...new Set([...fromSetting, ...fromEnv])]
}

/** Valid numeric Telegram chat IDs only (user, group, supergroup). */
export function normalizeOwnerChatIds(ids: string[]): string[] {
  return [...new Set(ids.map(id => id.trim()).filter(id => CHAT_ID_RE.test(id)))]
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

export async function resolveOwnerChatIds(businessId: string): Promise<string[]> {
  const setting = await getTelegramOpsSetting(businessId)
  if (!setting.enabled) return []
  return normalizeOwnerChatIds(parseOwnerChatIds(setting.ownerChatIds))
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
    case 'OPS_DAILY_SUMMARY':
      return setting.alertOpsDailySummary
    default:
      return true
  }
}

/** Late-specific alerts piggyback on check-in when alertAttendanceLate is off but check-in is on. */
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
