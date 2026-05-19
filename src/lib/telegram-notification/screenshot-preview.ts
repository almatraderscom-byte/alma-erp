import crypto from 'crypto'
import { erpBaseUrl } from '@/lib/telegram-notification/formatters'

const DEFAULT_TTL_SEC = 60 * 60

function previewSecret(): string {
  return (
    process.env.TELEGRAM_PREVIEW_SECRET
    || process.env.TELEGRAM_WEBHOOK_SECRET
    || process.env.CRON_SECRET
    || ''
  )
}

export function signScreenshotTelegramToken(screenshotId: string, ttlSec = DEFAULT_TTL_SEC) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec
  const secret = previewSecret()
  if (!secret) return null
  const sig = crypto.createHmac('sha256', secret).update(`${screenshotId}:${exp}`).digest('hex')
  return { exp, sig }
}

export function verifyScreenshotTelegramToken(screenshotId: string, exp: number, sig: string): boolean {
  const secret = previewSecret()
  if (!secret || !sig || !Number.isFinite(exp)) return false
  if (exp < Math.floor(Date.now() / 1000)) return false
  const expected = crypto.createHmac('sha256', secret).update(`${screenshotId}:${exp}`).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))
  } catch {
    return false
  }
}

/** Absolute URL Telegram servers can fetch (HMAC-protected, no session cookie). */
export function telegramScreenshotPreviewUrl(screenshotId: string): string | null {
  const signed = signScreenshotTelegramToken(screenshotId)
  if (!signed) return null
  const base = erpBaseUrl()
  const qs = new URLSearchParams({ exp: String(signed.exp), sig: signed.sig })
  return `${base}/api/trading/screenshots/${encodeURIComponent(screenshotId)}/telegram?${qs.toString()}`
}
