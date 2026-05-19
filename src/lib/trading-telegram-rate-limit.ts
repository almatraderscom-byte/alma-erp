const buckets = new Map<string, number[]>()

const WINDOW_MS = 60_000
const MAX_PER_WINDOW = Number(process.env.TELEGRAM_RATE_LIMIT_PER_MINUTE || 12)

export function telegramRateLimitKey(telegramUserId: string, chatId: string): string {
  return `${telegramUserId}:${chatId}`
}

export function checkTelegramRateLimit(telegramUserId: string, chatId: string): { allowed: boolean; retryAfterSec?: number } {
  const key = telegramRateLimitKey(telegramUserId, chatId)
  const now = Date.now()
  const prev = buckets.get(key) ?? []
  const recent = prev.filter(ts => now - ts < WINDOW_MS)
  if (recent.length >= MAX_PER_WINDOW) {
    const oldest = recent[0] ?? now
    const retryAfterSec = Math.ceil((WINDOW_MS - (now - oldest)) / 1000)
    buckets.set(key, recent)
    return { allowed: false, retryAfterSec }
  }
  recent.push(now)
  buckets.set(key, recent)
  return { allowed: true }
}
