import { captureStructuredEvent } from '@/lib/sentry/capture'

type LogLevel = 'info' | 'warn' | 'error'

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
    fetch('https://in.logs.betterstack.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${logtailToken}` },
      body: line,
      cache: 'no-store',
    }).catch(() => {})
  }

  void captureStructuredEvent(level, event, meta)
}

export function errorMeta(error: unknown) {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack?.split('\n').slice(0, 5).join('\n') }
  }
  return { message: String(error) }
}
