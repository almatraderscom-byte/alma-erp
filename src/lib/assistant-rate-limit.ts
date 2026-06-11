/**
 * In-memory per-key rate limit for /api/assistant/chat (per serverless instance).
 */

type Bucket = { count: number; resetAt: number }

const buckets = new Map<string, Bucket>()

export function checkAssistantChatRateLimit(
  key: string,
  limitPerMinute: number,
): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now()
  const windowMs = 60_000
  let bucket = buckets.get(key)
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs }
    buckets.set(key, bucket)
  }
  bucket.count += 1
  if (bucket.count > limitPerMinute) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    return { ok: false, retryAfterSec }
  }
  return { ok: true }
}
