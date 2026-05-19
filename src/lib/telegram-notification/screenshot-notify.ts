import {
  formatScreenshotUploadAlert,
  tradingDeepLink,
} from '@/lib/telegram-notification/formatters'
import {
  enqueueTelegramNotification,
  flushTelegramNotificationQueue,
} from '@/lib/telegram-notification/queue'

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
 * Enqueue + immediately deliver screenshot upload alerts (awaited from upload route).
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
    const enqueued = await enqueueTelegramNotification({
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

    if (!enqueued.ok) {
      console.warn('[telegram-screenshot] not enqueued', {
        screenshotId: input.screenshotId,
        skipped: enqueued.skipped,
        recipients: enqueued.recipientCount,
      })
      return enqueued
    }

    if (enqueued.duplicate) {
      return enqueued
    }

    if (enqueued.ids?.length) {
      const delivered = await flushTelegramNotificationQueue({
        ids: enqueued.ids,
        limit: enqueued.ids.length,
      })
      console.info('[telegram-screenshot] delivered', {
        screenshotId: input.screenshotId,
        rows: enqueued.ids.length,
        processed: delivered.processed,
        results: delivered.results,
      })
      return { ...enqueued, delivered }
    }

    return enqueued
  } catch (e) {
    console.error('[telegram-screenshot] notify failed', {
      screenshotId: input.screenshotId,
      message: (e as Error).message,
    })
    return { ok: false, skipped: 'EXCEPTION' }
  }
}
