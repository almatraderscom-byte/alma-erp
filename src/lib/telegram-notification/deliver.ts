import type { TelegramNotificationEventType, TelegramNotificationQueue } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { logTelegram } from '@/lib/telegram-notification/telegram-log'
import { fetchTradingScreenshotFromDrive } from '@/lib/trading-drive'
import { loadTelegramProfileAvatar } from '@/lib/telegram-profile-avatar'
import {
  sendTelegramMediaGroup,
  sendTelegramMessage,
  sendTelegramPhoto,
  sendTelegramPhotoBuffer,
  type TelegramSendResult,
} from '@/lib/trading-telegram-bot'
import { thumbBufferFromDataUrl } from '@/lib/attendance-face-image'
import { consumeLiveFacePhoto } from '@/lib/telegram-notification/face-photo-staging'
import { telegramScreenshotPreviewUrl } from '@/lib/telegram-notification/screenshot-preview'

export type QueueRowMeta = {
  screenshotId?: string
  accountId?: string
  accountTitle?: string
  attendanceRecordId?: string
  employeeId?: string
  entityId?: string
  requestId?: string
  waiverId?: string
  userId?: string
  employeeName?: string
  monitorScanAt?: string
  uploaderName?: string
  shotDate?: string
  type?: string
  deliveryMode?: 'photo' | 'face_photo' | 'text' | 'profile_avatar'
  replyMarkup?: {
    inline_keyboard?: Array<Array<{ text: string; callback_data?: string; url?: string }>>
  }
}

const PROFILE_AVATAR_EVENTS = new Set<TelegramNotificationEventType>([
  'ATTENDANCE_CHECK_IN',
  'ATTENDANCE_CHECK_OUT',
  'ATTENDANCE_ABSENT',
  'ATTENDANCE_NO_CHECKOUT',
  'ATTENDANCE_EARLY_LEAVE',
  'ATTENDANCE_SUSPICIOUS',
  'ATTENDANCE_WAIVER_SUBMITTED',
  'ATTENDANCE_WAIVER_REVIEWED',
  'TRADING_SCREENSHOT_FAILURE',
  'TRADING_DELETE_REQUEST',
  'PAYROLL_WALLET_REQUEST',
])

export function parseQueueMetadata(raw: string | null | undefined): QueueRowMeta {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as QueueRowMeta
  } catch {
    return {}
  }
}

async function deliverProfileAvatar(
  row: TelegramNotificationQueue,
  meta: QueueRowMeta,
): Promise<TelegramSendResult> {
  const userId = meta.userId
  if (!userId) return sendTelegramMessage(row.chatId, row.message)

  const avatar = await loadTelegramProfileAvatar(userId, meta.employeeName)
  if (!avatar) return sendTelegramMessage(row.chatId, row.message)

  return sendTelegramPhotoBuffer(
    row.chatId,
    avatar.buffer,
    avatar.fileName,
    avatar.contentType,
    row.message,
  )
}

async function resolveScreenshotBuffer(screenshotId: string) {
  const shot = await prisma.tradingPerformanceScreenshot.findFirst({
    where: { id: screenshotId, deletedAt: null },
    select: { driveFileId: true, contentType: true, originalName: true },
  })
  if (shot?.driveFileId) {
    try {
      const file = await fetchTradingScreenshotFromDrive(shot.driveFileId)
      return {
        buffer: Buffer.from(file.base64, 'base64'),
        fileName: file.file_name || shot.originalName || 'screenshot.webp',
        mimeType: file.mime_type || shot.contentType || 'image/webp',
      }
    } catch {
      /* try preview URL */
    }
  }

  const previewUrl = telegramScreenshotPreviewUrl(screenshotId)
  if (previewUrl) {
    try {
      const res = await fetch(previewUrl)
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer())
        if (buffer.length) {
          return {
            buffer,
            fileName: shot?.originalName || 'screenshot.webp',
            mimeType: res.headers.get('content-type') || shot?.contentType || 'image/webp',
          }
        }
      }
    } catch {
      return null
    }
  }

  return null
}

async function deliverScreenshotPhoto(
  row: TelegramNotificationQueue,
  meta: QueueRowMeta,
): Promise<TelegramSendResult> {
  const screenshotId = meta.screenshotId
  if (!screenshotId) {
    return deliverProfileAvatar(row, meta)
  }

  const previewUrl = telegramScreenshotPreviewUrl(screenshotId)
  const avatar = meta.userId
    ? await loadTelegramProfileAvatar(meta.userId, meta.employeeName)
    : null

  const screenshotFile = await resolveScreenshotBuffer(screenshotId)

  if (avatar && screenshotFile) {
    const group = await sendTelegramMediaGroup(row.chatId, [
      {
        buffer: avatar.buffer,
        fileName: avatar.fileName,
        mimeType: avatar.contentType,
      },
      {
        buffer: screenshotFile.buffer,
        fileName: screenshotFile.fileName,
        mimeType: screenshotFile.mimeType,
        caption: row.message,
      },
    ])
    if (group.ok) return group
  }

  if (previewUrl) {
    const photo = await sendTelegramPhoto(row.chatId, previewUrl, row.message)
    if (photo.ok) return photo
  }

  if (screenshotFile) {
    const bufferResult = await sendTelegramPhotoBuffer(
      row.chatId,
      screenshotFile.buffer,
      screenshotFile.fileName,
      screenshotFile.mimeType,
      row.message,
    )
    if (bufferResult.ok) return bufferResult
  }

  if (avatar) {
    return sendTelegramPhotoBuffer(
      row.chatId,
      avatar.buffer,
      avatar.fileName,
      avatar.contentType,
      row.message,
    )
  }

  return sendTelegramMessage(row.chatId, row.message)
}

const TELEGRAM_DELIVERY_TIMEOUT_MS = 22_000

async function withTelegramDeliveryTimeout<T>(
  label: string,
  row: TelegramNotificationQueue,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout`)), TELEGRAM_DELIVERY_TIMEOUT_MS)
      }),
    ])
  } catch (e) {
    logTelegram('warn', 'telegram.deliver.timeout', {
      id: row.id,
      eventType: row.eventType,
      label,
      latencyMs: Date.now() - started,
      message: (e as Error).message,
    })
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function deliverFaceVerifiedPhoto(
  row: TelegramNotificationQueue,
  meta: QueueRowMeta,
): Promise<TelegramSendResult> {
  const attendanceRecordId = meta.attendanceRecordId
  if (!attendanceRecordId) return deliverProfileAvatar(row, meta)

  try {
    return await withTelegramDeliveryTimeout('face_photo', row, async () => {
      const live = consumeLiveFacePhoto(attendanceRecordId)
      if (live) {
        const photo = await sendTelegramPhotoBuffer(
          row.chatId,
          live.buffer,
          'face-verification.jpg',
          live.contentType,
          row.message,
        )
        if (photo.ok) return photo
      }

      const record = await prisma.attendanceRecord.findFirst({
        where: { id: attendanceRecordId },
        select: { faceThumbDataUrl: true, userId: true },
      })
      const thumb = thumbBufferFromDataUrl(record?.faceThumbDataUrl)
      if (thumb) {
        const photo = await sendTelegramPhotoBuffer(
          row.chatId,
          thumb,
          'face-verification.jpg',
          'image/jpeg',
          row.message,
        )
        if (photo.ok) return photo
      }

      if (record?.userId) {
        return deliverProfileAvatar(row, { ...meta, userId: record.userId })
      }

      return sendTelegramMessage(row.chatId, `${row.message}\n\n<i>Photo preview unavailable — open ERP link.</i>`)
    })
  } catch {
    return sendTelegramMessage(
      row.chatId,
      `${row.message}\n\n<i>Photo delivery timed out — open ERP link for verification image.</i>`,
    )
  }
}

export async function deliverTelegramNotificationRow(
  row: TelegramNotificationQueue,
): Promise<TelegramSendResult> {
  const meta = parseQueueMetadata(row.metadataJson)

  if (row.eventType === 'ATTENDANCE_FACE_VERIFIED_CHECK_IN') {
    return deliverFaceVerifiedPhoto(row, meta)
  }

  if (row.eventType === 'ATTENDANCE_WAIVER_SUBMITTED' && meta.replyMarkup) {
    return sendTelegramMessage(row.chatId, row.message, {
      replyMarkup: meta.replyMarkup as import('@/lib/trading-telegram-bot').TelegramSendOptions['replyMarkup'],
    })
  }

  if (row.eventType === 'TRADING_SCREENSHOT_UPLOAD') {
    return deliverScreenshotPhoto(row, meta)
  }

  if (
    PROFILE_AVATAR_EVENTS.has(row.eventType)
    && meta.userId
    && meta.deliveryMode !== 'text'
  ) {
    return deliverProfileAvatar(row, meta)
  }

  return sendTelegramMessage(row.chatId, row.message)
}
