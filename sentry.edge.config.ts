import * as Sentry from '@sentry/nextjs'
import { baseSentryOptions, isSentryEnabled } from '@/lib/sentry/config'

if (isSentryEnabled()) {
  const base = baseSentryOptions()
  Sentry.init({
    ...base,
    // Edge runtime is bandwidth/cpu sensitive — cap traces tighter.
    tracesSampleRate: Math.min(base.tracesSampleRate ?? 0, 0.02),
  })
}
