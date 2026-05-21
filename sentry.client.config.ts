import * as Sentry from '@sentry/nextjs'
import { baseSentryOptions } from '@/lib/sentry/config'

Sentry.init({
  ...baseSentryOptions(),
  integrations: [Sentry.browserTracingIntegration()],
})
