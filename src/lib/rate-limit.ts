import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

type Bucket = { count: number; resetAt: number }

const buckets = new Map<string, Bucket>()

export function rateLimit(req: NextRequest, key: string, limit = 120, windowMs = 60_000) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'local'
  const now = Date.now()
  const id = `${key}:${ip}`
  const bucket = buckets.get(id)
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(id, { count: 1, resetAt: now + windowMs })
    return null
  }
  bucket.count += 1
  if (bucket.count > limit) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((bucket.resetAt - now) / 1000)) } },
    )
  }
  return null
}
