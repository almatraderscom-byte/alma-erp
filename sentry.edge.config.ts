import * as Sentry from '@sentry/nextjs'
import { baseSentryOptions } from '@/lib/sentry/config'

Sentry.init({
  ...baseSentryOptions(),
  tracesSampleRate: Math.min(baseSentryOptions().tracesSampleRate ?? 0, 0.02),
})
