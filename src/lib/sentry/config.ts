/**
 * Shared Sentry options — production-safe sampling, no session replay.
 */
import type { BrowserOptions, NodeOptions } from '@sentry/nextjs'

export function isSentryEnabled(): boolean {
  if (process.env.SENTRY_ENABLED === 'false') return false
  const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN
  return Boolean(dsn?.trim())
}

export function sentryEnvironment(): string {
  return (
    process.env.SENTRY_ENVIRONMENT
    || process.env.VERCEL_ENV
    || process.env.NODE_ENV
    || 'development'
  )
}

export function sentryRelease(): string | undefined {
  return (
    process.env.SENTRY_RELEASE
    || process.env.VERCEL_GIT_COMMIT_SHA
    || process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT
    || undefined
  )
}

function tracesSampleRate(): number {
  const raw = process.env.SENTRY_TRACES_SAMPLE_RATE
  if (raw != null && raw !== '') {
    const n = Number(raw)
    if (!Number.isNaN(n)) return Math.min(1, Math.max(0, n))
  }
  if (sentryEnvironment() === 'production') return 0.05
  if (sentryEnvironment() === 'preview') return 0.02
  return 0
}

function profilesSampleRate(): number {
  const raw = process.env.SENTRY_PROFILES_SAMPLE_RATE
  if (raw != null && raw !== '') {
    const n = Number(raw)
    if (!Number.isNaN(n)) return Math.min(1, Math.max(0, n))
  }
  return 0
}

const IGNORE_ERRORS = [
  /^ResizeObserver loop/,
  /^Non-Error promise rejection captured/,
  /Loading chunk \d+ failed/,
  /ChunkLoadError/,
  'NEXT_NOT_FOUND',
  'NEXT_REDIRECT',
]

/** Drop noisy non-actionable events in production. */
export function beforeSendEvent<T extends { level?: string; tags?: Record<string, string>; request?: { url?: string } }>(
  event: T,
): T | null {
  const env = sentryEnvironment()
  if (env === 'development') return event

  const url = event.request?.url || ''
  if (url.includes('/api/health') && event.level === 'warning') return null

  return event
}

export function baseSentryOptions(): Partial<NodeOptions & BrowserOptions> {
  const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN
  return {
    dsn,
    enabled: isSentryEnabled(),
    environment: sentryEnvironment(),
    release: sentryRelease(),
    tracesSampleRate: tracesSampleRate(),
    profilesSampleRate: profilesSampleRate(),
    sampleRate: 1,
    debug: process.env.SENTRY_DEBUG === 'true',
    ignoreErrors: IGNORE_ERRORS,
    beforeSend: beforeSendEvent as BrowserOptions['beforeSend'],
    initialScope: {
      tags: {
        app: 'alma-erp',
        runtime: typeof window === 'undefined' ? 'server' : 'browser',
      },
    },
  }
}
