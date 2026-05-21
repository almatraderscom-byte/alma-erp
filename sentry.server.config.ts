import * as Sentry from '@sentry/nextjs'
import { baseSentryOptions, isSentryEnabled } from '@/lib/sentry/config'

if (isSentryEnabled()) {
  Sentry.init({
    ...baseSentryOptions(),
    // Server-side: requestId is set as a tag from withApiRoute scope, so we
    // intentionally do not enable Sentry's HTTP integration body capture
    // (that would re-introduce attendance photo bodies).
    integrations: [],
  })
}
