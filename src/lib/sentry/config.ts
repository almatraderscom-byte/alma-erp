/**
 * Shared Sentry options — production-safe sampling, replay-on-error, deep
 * scrubbing for attendance photos / secrets, request-id propagation hooks.
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

function clampRate(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  if (Number.isNaN(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

function tracesSampleRate(): number {
  const raw = process.env.SENTRY_TRACES_SAMPLE_RATE
  if (raw != null && raw !== '') return clampRate(raw, 0)
  if (sentryEnvironment() === 'production') return 0.05
  if (sentryEnvironment() === 'preview') return 0.02
  return 0
}

function profilesSampleRate(): number {
  return clampRate(process.env.SENTRY_PROFILES_SAMPLE_RATE, 0)
}

/** Session replay: never sampled at random — only when an error fires. */
export function replaysSessionSampleRate(): number {
  return clampRate(process.env.SENTRY_REPLAY_SESSION_SAMPLE_RATE, 0)
}

/** Session replay: portion of error-bearing sessions to record. */
export function replaysOnErrorSampleRate(): number {
  if (sentryEnvironment() === 'production') {
    return clampRate(process.env.SENTRY_REPLAY_ERROR_SAMPLE_RATE, 0.2)
  }
  if (sentryEnvironment() === 'preview') {
    return clampRate(process.env.SENTRY_REPLAY_ERROR_SAMPLE_RATE, 0.1)
  }
  return clampRate(process.env.SENTRY_REPLAY_ERROR_SAMPLE_RATE, 0)
}

const IGNORE_ERRORS: Array<string | RegExp> = [
  /^ResizeObserver loop/,
  /^Non-Error promise rejection captured/,
  /Loading chunk \d+ failed/,
  /ChunkLoadError/,
  // iOS Safari background tab quirks — extremely noisy, not actionable
  /AbortError: The user aborted a request/,
  /AbortError: The operation was aborted/,
  /Failed to fetch dynamically imported module/,
  // PWA install/visibility races
  /undefined is not an object \(evaluating 'navigator\.serviceWorker'/,
  'NEXT_NOT_FOUND',
  'NEXT_REDIRECT',
]

// ─── Sensitive-data scrubber ───────────────────────────────────────────────

const SENSITIVE_FIELD_NAMES = new Set([
  // attendance photo data
  'image_data_url',
  'thumb_data_url',
  'imageDataUrl',
  'thumbDataUrl',
  'face_verification',
  'face_image_data_url',
  'faceImageDataUrl',
  'attachmentDataUrl',
  'attachmentDataUrls',
  'photoDataUrl',
  'photoUrl',
  // credentials / tokens
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'token',
  'authToken',
  'apiKey',
  'apikey',
  'secret',
  'sessionToken',
  'cookie',
  'authorization',
  // employee KYC
  'phone',
  'phoneNumber',
])

const REDACTED = '[Filtered]'
const MAX_STRING_LENGTH = 4096

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase()
  if (SENSITIVE_FIELD_NAMES.has(key)) return true
  if (SENSITIVE_FIELD_NAMES.has(k)) return true
  if (k.includes('password')) return true
  if (k.includes('secret')) return true
  if (k.includes('token') && !k.includes('telegramuserid')) return true
  if (k.includes('apikey')) return true
  if (k === 'set-cookie' || k === 'cookie') return true
  return false
}

function scrubString(value: string): string {
  if (!value) return value
  // Inline data: URLs (face photos, attachments) — replace with marker, keep mime.
  if (value.startsWith('data:image/')) {
    const semi = value.indexOf(';')
    const head = semi > 0 ? value.slice(0, semi) : 'data:image'
    return `${head};base64,${REDACTED}`
  }
  // Bearer tokens, Telegram bot tokens, anything that looks like a JWT.
  if (/^Bearer\s+[A-Za-z0-9._\-]+$/i.test(value)) return REDACTED
  if (/^[0-9]{6,}:[A-Za-z0-9_-]{20,}$/.test(value)) return REDACTED // telegram bot token shape
  if (/^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/.test(value)) return REDACTED
  if (value.length > MAX_STRING_LENGTH) return value.slice(0, MAX_STRING_LENGTH) + '…[truncated]'
  return value
}

function scrubValue(value: unknown, depth = 0): unknown {
  if (value == null) return value
  if (depth > 6) return REDACTED
  if (typeof value === 'string') return scrubString(value)
  if (Array.isArray(value)) return value.map(v => scrubValue(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        out[k] = REDACTED
      } else {
        out[k] = scrubValue(v, depth + 1)
      }
    }
    return out
  }
  return value
}

function scrubRecord(target: Record<string, unknown> | undefined): void {
  if (!target) return
  for (const [k, v] of Object.entries(target)) {
    if (isSensitiveKey(k)) {
      target[k] = REDACTED
      continue
    }
    target[k] = scrubValue(v) as unknown
  }
}

type SentryEvent = {
  level?: string
  tags?: Record<string, string>
  request?: { url?: string; data?: unknown; headers?: Record<string, string> }
  extra?: Record<string, unknown>
  contexts?: Record<string, Record<string, unknown>>
  breadcrumbs?: Array<{ category?: string; data?: Record<string, unknown>; message?: string }>
}

/** Drop noisy non-actionable events; deep-scrub PII/photo payloads in production. */
export function beforeSendEvent<T extends SentryEvent>(event: T): T | null {
  const env = sentryEnvironment()

  const url = event.request?.url || ''
  if (url.includes('/api/health') && event.level === 'warning') return null

  // Scrub headers (Cookie, Authorization).
  if (event.request?.headers) {
    for (const k of Object.keys(event.request.headers)) {
      if (isSensitiveKey(k)) event.request.headers[k] = REDACTED
    }
  }

  // Scrub request body (attendance photos, passwords, tokens).
  if (event.request && event.request.data != null) {
    if (typeof event.request.data === 'string') {
      event.request.data = scrubString(event.request.data)
    } else if (typeof event.request.data === 'object') {
      event.request.data = scrubValue(event.request.data)
    }
  }

  // Scrub extra + contexts (we put metadata there).
  scrubRecord(event.extra)
  if (event.contexts) {
    for (const ctx of Object.values(event.contexts)) {
      scrubRecord(ctx)
    }
  }

  // Scrub breadcrumb data (fetch, navigation, xhr can contain bodies).
  if (Array.isArray(event.breadcrumbs)) {
    for (const bc of event.breadcrumbs) {
      if (bc.data) scrubRecord(bc.data as Record<string, unknown>)
      if (bc.message) bc.message = scrubString(bc.message)
    }
  }

  if (env === 'development' && process.env.SENTRY_DEBUG !== 'true') return event
  return event
}

/** Scrub fetch/xhr breadcrumb bodies before they're attached to events. */
export function beforeBreadcrumb(breadcrumb: {
  category?: string
  data?: Record<string, unknown>
  message?: string
}): typeof breadcrumb | null {
  if (!breadcrumb) return breadcrumb

  // Drop fetch breadcrumbs to attendance photo endpoints entirely — even
  // request URLs can leak (e.g. signed URL params).
  const url = (breadcrumb.data?.url as string | undefined) || ''
  const isPhotoEndpoint =
    url.includes('/api/attendance/check-in')
    || url.includes('/api/attendance/check-in/face')
    || url.includes('/api/attendance/face-verify')
    || url.includes('/api/attendance/selfies')
    || url.includes('/api/penalty-appeal/')
    || url.includes('/api/users/me/profile-image')
    || (url.includes('/api/trading/accounts/') && url.includes('/performance'))
  if (isPhotoEndpoint) {
    return {
      ...breadcrumb,
      data: { url: url.split('?')[0], method: breadcrumb.data?.method, redacted: true },
      message: undefined,
    }
  }

  if (breadcrumb.data) scrubRecord(breadcrumb.data)
  if (breadcrumb.message) breadcrumb.message = scrubString(breadcrumb.message)
  return breadcrumb
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
    sendDefaultPii: false,
    maxBreadcrumbs: 50,
    normalizeDepth: 5,
    ignoreErrors: IGNORE_ERRORS,
    beforeSend: beforeSendEvent as BrowserOptions['beforeSend'],
    beforeBreadcrumb: beforeBreadcrumb as BrowserOptions['beforeBreadcrumb'],
    initialScope: {
      tags: {
        app: 'alma-erp',
        runtime: typeof window === 'undefined' ? 'server' : 'browser',
      },
    },
  }
}
