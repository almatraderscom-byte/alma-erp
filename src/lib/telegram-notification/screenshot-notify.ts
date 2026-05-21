import {
  formatScreenshotUploadAlert,
  tradingDeepLink,
} from '@/lib/telegram-notification/formatters'
import { scheduleTelegramNotification } from '@/lib/telegram-notification/queue'
import { withEmployeeAvatarMetadata } from '@/lib/telegram-notification/enqueue-metadata'

export type ScreenshotUploadNotifyInput = {
  businessId: string
  screenshotId: string
  accountId: string
  accountTitle: string
  uploaderUserId?: string
  uploaderName: string
  shotDate: string
}

/**
 * Enqueue screenshot upload alert (low priority — delivered by async queue worker).
 * Does not throw — logs failures only.
 */
export async function notifyTradingScreenshotUploaded(input: ScreenshotUploadNotifyInput) {
  const link = tradingDeepLink(`/trading/accounts/${input.accountId}`)
  const message = formatScreenshotUploadAlert({
    accountTitle: input.accountTitle,
    uploaderName: input.uploaderName,
    shotDate: input.shotDate,
    link,
  })

  try {
    const enqueue = await scheduleTelegramNotification({
      businessId: input.businessId,
      eventType: 'TRADING_SCREENSHOT_UPLOAD',
      message,
      dedupeKey: `screenshot:upload:${input.screenshotId}`,
      metadata: withEmployeeAvatarMetadata(
        {
          screenshotId: input.screenshotId,
          accountId: input.accountId,
          accountTitle: input.accountTitle,
          uploaderName: input.uploaderName,
          shotDate: input.shotDate,
          deliveryMode: 'photo',
        },
        input.uploaderUserId,
        input.uploaderName,
      ),
    })
    if (!enqueue.ok) {
      return { ok: false, skipped: enqueue.skipped || 'ENQUEUE_FAILED' }
    }
    return { ok: true, queued: true }
  } catch (e) {
    console.error('[telegram-screenshot] notify failed', {
      screenshotId: input.screenshotId,
      message: (e as Error).message,
    })
    return { ok: false, skipped: 'EXCEPTION' }
  }
}
