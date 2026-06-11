/**
 * Sentry for VPS worker — tagged module:agent.
 */
import * as Sentry from '@sentry/node'

let initialized = false

export function initWorkerSentry() {
  const dsn = process.env.SENTRY_DSN
  if (!dsn || initialized) return
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: 0.05,
    beforeSend(event) {
      event.tags = { ...event.tags, module: 'agent', runtime: 'worker' }
      return event
    },
  })
  initialized = true

  process.on('unhandledRejection', (reason) => {
    captureWorkerError(reason, 'worker.unhandled_rejection')
  })
}

export function captureWorkerError(err, event, context = {}) {
  if (!initialized) {
    console.error(`[sentry-skip] ${event}:`, err instanceof Error ? err.message : String(err))
    return
  }
  Sentry.withScope((scope) => {
    scope.setTag('module', 'agent')
    scope.setTag('event', event)
    for (const [k, v] of Object.entries(context)) {
      scope.setExtra(k, v)
    }
    if (err instanceof Error) {
      Sentry.captureException(err)
    } else {
      Sentry.captureMessage(String(err), 'error')
    }
  })
}
