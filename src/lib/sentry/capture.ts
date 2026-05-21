/**
 * Structured Sentry capture — wired from logger, API routes, Prisma, and React boundaries.
 */
import type { SeverityLevel } from '@sentry/nextjs'
import { isSentryEnabled } from '@/lib/sentry/config'

export type SentryCategory =
  | 'api'
  | 'prisma'
  | 'telegram'
  | 'approval'
  | 'attendance'
  | 'archive'
  | 'orders'
  | 'hydration'
  | 'client'
  | 'erp'

/** Events that should always alert in Sentry (paired with alert rules in docs/SENTRY.md). */
const CRITICAL_EVENT_PATTERNS: RegExp[] = [
  /^approval\.(tx\.|action\.failed|execute_failed|api\.failed)/,
  /^telegram\.(cron\.|deliver\.|queue\.|owner\.routing)/,
  /\.failed$/,
  /^attendance\.api\.failed/,
  /^attendance\.telegram_event_missing/,
  /^attendance\.checkin\.transaction_failed/,
  /^attendance\.checkin\.side_effect_failed/,
  /^archive\.filter\.failed/,
  /^orders\.provider\.missing/,
  /^database_error/,
  /^prisma\./,
]

export function eventCategory(event: string): SentryCategory {
  if (event.startsWith('approval.')) return 'approval'
  if (event.startsWith('telegram.')) return 'telegram'
  if (event.startsWith('attendance.')) return 'attendance'
  if (event.startsWith('archive.')) return 'archive'
  if (event.startsWith('orders.')) return 'orders'
  if (event.includes('hydration')) return 'hydration'
  if (event.startsWith('prisma.') || event.includes('database')) return 'prisma'
  return 'erp'
}

export function isCriticalErpEvent(event: string, level: string): boolean {
  if (level === 'warn' && event.startsWith('telegram.')) return true
  if (level !== 'error') return false
  if (CRITICAL_EVENT_PATTERNS.some(p => p.test(event))) return true
  if (event.endsWith('.failed')) return true
  if (event.includes('.api.failed') || event.includes('.tx.')) return true
  return false
}

function levelToSeverity(level: string): SeverityLevel {
  if (level === 'error') return 'error'
  if (level === 'warn') return 'warning'
  return 'info'
}

async function getSentry() {
  if (!isSentryEnabled()) return null
  try {
    return await import('@sentry/nextjs')
  } catch {
    return null
  }
}

export async function captureStructuredEvent(
  level: string,
  event: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  if (!isSentryEnabled()) return
  if (!isCriticalErpEvent(event, level) && level !== 'error') return

  const Sentry = await getSentry()
  if (!Sentry) return

  const category = eventCategory(event)
  const critical = isCriticalErpEvent(event, level)
  const fingerprint = [event, String(meta.code || meta.route || category)]

  Sentry.withScope(scope => {
    scope.setTag('erp.event', event)
    scope.setTag('category', category)
    scope.setTag('critical', critical ? 'true' : 'false')
    scope.setLevel(levelToSeverity(level))
    scope.setFingerprint(fingerprint)
    for (const [k, v] of Object.entries(meta)) {
      if (v == null || k === 'stack') continue
      scope.setExtra(k, v)
    }
    if (meta.errMessage && typeof meta.errMessage === 'string') {
      Sentry.captureException(new Error(`${event}: ${meta.errMessage}`))
    } else {
      Sentry.captureMessage(event, levelToSeverity(level))
    }
  })
}

export async function captureException(
  error: unknown,
  context: {
    category?: SentryCategory
    event?: string
    extra?: Record<string, unknown>
    critical?: boolean
  } = {},
): Promise<void> {
  if (!isSentryEnabled()) return
  const Sentry = await getSentry()
  if (!Sentry) return

  const category = context.category || 'erp'
  const critical = context.critical ?? true

  Sentry.withScope(scope => {
    scope.setTag('category', category)
    scope.setTag('critical', critical ? 'true' : 'false')
    if (context.event) scope.setTag('erp.event', context.event)
    if (context.extra) {
      for (const [k, v] of Object.entries(context.extra)) {
        if (v != null) scope.setExtra(k, v)
      }
    }
    if (error instanceof Error) {
      Sentry.captureException(error)
    } else {
      Sentry.captureException(new Error(String(error)))
    }
  })
}

export async function capturePrismaError(
  error: unknown,
  meta: { model?: string; operation?: string; label?: string },
): Promise<void> {
  const message = (error as Error).message || String(error)
  await captureException(error, {
    category: 'prisma',
    event: 'prisma.query.failed',
    critical: true,
    extra: { ...meta, errMessage: message },
  })
}

export async function captureHydrationError(error: unknown, extra?: Record<string, unknown>): Promise<void> {
  await captureException(error, {
    category: 'hydration',
    event: 'react.hydration.failed',
    critical: true,
    extra,
  })
}

export function setSentryUser(user: {
  id?: string
  email?: string | null
  name?: string | null
  role?: string
  businessAccess?: string
} | null): void {
  if (!isSentryEnabled()) return
  void getSentry().then(Sentry => {
    if (!Sentry) return
    if (!user?.id) {
      Sentry.setUser(null)
      return
    }
    Sentry.setUser({
      id: user.id,
      email: user.email || undefined,
      username: user.name || undefined,
    })
    Sentry.setTag('user.role', user.role || 'unknown')
    if (user.businessAccess) Sentry.setTag('user.business_access', user.businessAccess)
  })
}
