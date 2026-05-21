import { captureStructuredEvent } from '@/lib/sentry/capture'

type LogLevel = 'info' | 'warn' | 'error'

/** Hard timeout for the Logtail HTTP shipping fetch — never block the lambda. */
const LOGTAIL_FETCH_TIMEOUT_MS = 1_500

function postLogtail(line: string, token: string) {
  if (typeof AbortController === 'undefined') {
    fetch('https://in.logs.betterstack.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: line,
      cache: 'no-store',
    }).catch(() => {})
    return
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LOGTAIL_FETCH_TIMEOUT_MS)
  fetch('https://in.logs.betterstack.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: line,
    cache: 'no-store',
    signal: controller.signal,
  })
    .catch(() => {})
    .finally(() => clearTimeout(timer))
}

export function logEvent(level: LogLevel, event: string, meta: Record<string, unknown> = {}) {
  const payload = {
    level,
    event,
    timestamp: new Date().toISOString(),
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown',
    ...meta,
  }
  const line = JSON.stringify(payload)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)

  const logtailToken = process.env.LOGTAIL_SOURCE_TOKEN
  if (logtailToken && process.env.NODE_ENV === 'production') {
    postLogtail(line, logtailToken)
  }

  void captureStructuredEvent(level, event, meta)
}

export function errorMeta(error: unknown) {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack?.split('\n').slice(0, 5).join('\n') }
  }
  return { message: String(error) }
}
