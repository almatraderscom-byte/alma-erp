/**
 * Sentry for VPS worker — tagged module:agent.
 */
import * as Sentry from '@sentry/node'

let initialized = false
let floodCount = 0

/** True for high-frequency, low-signal reasons that must be rate-limited. */
function isFloodingReason(reason) {
  const m = String(reason?.message ?? reason ?? '')
  return m.includes('max requests limit') ||
    m.includes('max daily request') ||
    m.includes('Connection is closed') ||
    m.includes('ECONNREFUSED')
}

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
    // Storm guard (2026-07-14): a metered Redis over its quota can reject
    // thousands of commands/sec. Left unthrottled that floods the disk log and
    // burns the Sentry quota. Rate-limit floods of the same repeated reason so
    // one sick dependency can't take out observability too.
    if (isFloodingReason(reason)) {
      floodCount++
      if (floodCount % 1000 !== 1) return
      captureWorkerError(reason, 'worker.unhandled_rejection', { floodCount })
      return
    }
    captureWorkerError(reason, 'worker.unhandled_rejection')
  })
}

export function captureWorkerError(errOrEvent, eventOrErr, context = {}) {
  let err, event
  if (typeof errOrEvent === 'string') {
    event = errOrEvent
    err = eventOrErr
  } else {
    err = errOrEvent
    event = typeof eventOrErr === 'string' ? eventOrErr : 'worker.unknown'
  }
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
