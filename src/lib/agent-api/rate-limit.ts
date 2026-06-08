import { NextRequest, NextResponse } from 'next/server'

const MAX_TOKENS = 30
const REFILL_MS = 1000

type Bucket = { tokens: number; lastRefill: number }

const buckets = new Map<string, Bucket>()

function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown'
  return req.headers.get('x-real-ip')?.trim() || 'unknown'
}

export function checkRateLimit(req: NextRequest): NextResponse | null {
  const ip = clientIp(req)
  const now = Date.now()
  let bucket = buckets.get(ip)
  if (!bucket) {
    bucket = { tokens: MAX_TOKENS, lastRefill: now }
    buckets.set(ip, bucket)
  }

  const elapsed = now - bucket.lastRefill
  if (elapsed >= REFILL_MS) {
    const refill = Math.floor(elapsed / REFILL_MS) * MAX_TOKENS
    bucket.tokens = Math.min(MAX_TOKENS, bucket.tokens + refill)
    bucket.lastRefill = now
  }

  if (bucket.tokens <= 0) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': '1' } },
    )
  }

  bucket.tokens -= 1
  return null
}

/** Test helper */
export function resetRateLimitForTests(): void {
  buckets.clear()
}
