import {
  formatDeleteRequestAlert,
  formatScreenshotFailureAlert,
  tradingDeepLink,
} from '@/lib/telegram-notification/formatters'
import { withEmployeeAvatarMetadata } from '@/lib/telegram-notification/enqueue-metadata'
import { scheduleTelegramNotificationAndFlush } from '@/lib/telegram-notification/queue'
import { notifyTradingScreenshotUploaded } from '@/lib/telegram-notification/screenshot-notify'

export async function queueTradingScreenshotUploadAlert(input: {
  businessId: string
  screenshotId: string
  accountId: string
  accountTitle: string
  uploaderUserId?: string
  uploaderName: string
  shotDate: string
}) {
  return notifyTradingScreenshotUploaded(input)
}

export function queueTradingScreenshotFailureAlert(input: {
  businessId: string
  accountId: string
  accountTitle: string
  uploaderUserId?: string
  uploaderName: string
  error: string
  screenshotId?: string
}) {
  scheduleTelegramNotificationAndFlush({
    businessId: input.businessId,
    eventType: 'TRADING_SCREENSHOT_FAILURE',
    message: formatScreenshotFailureAlert({
      accountTitle: input.accountTitle,
      uploaderName: input.uploaderName,
      error: input.error,
      link: tradingDeepLink(`/trading/accounts/${input.accountId}`),
    }),
    dedupeKey: input.screenshotId
      ? `screenshot:fail:${input.screenshotId}`
      : `screenshot:fail:${input.accountId}:${Date.now()}`,
    metadata: withEmployeeAvatarMetadata(
      { ...input, deliveryMode: input.screenshotId ? 'photo' : 'profile_avatar' },
      input.uploaderUserId,
      input.uploaderName,
    ),
  })
}

export function queueTradingDeleteRequestAlert(input: {
  businessId: string
  accountTitle: string
  requesterUserId?: string
  requesterName: string
  reason: string
  approvalPath: string
  entityId: string
}) {
  scheduleTelegramNotificationAndFlush({
    businessId: input.businessId,
    eventType: 'TRADING_DELETE_REQUEST',
    message: formatDeleteRequestAlert({
      accountTitle: input.accountTitle,
      requesterName: input.requesterName,
      reason: input.reason,
      link: tradingDeepLink(input.approvalPath),
    }),
    dedupeKey: `trade:delete:${input.entityId}`,
    metadata: withEmployeeAvatarMetadata(
      { entityId: input.entityId, accountTitle: input.accountTitle },
      input.requesterUserId,
      input.requesterName,
    ),
  })
}
