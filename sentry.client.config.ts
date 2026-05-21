import * as Sentry from '@sentry/nextjs'
import {
  baseSentryOptions,
  isSentryEnabled,
  replaysOnErrorSampleRate,
  replaysSessionSampleRate,
} from '@/lib/sentry/config'

if (isSentryEnabled()) {
  Sentry.init({
    ...baseSentryOptions(),
    replaysSessionSampleRate: replaysSessionSampleRate(),
    replaysOnErrorSampleRate: replaysOnErrorSampleRate(),
    integrations: [
      Sentry.browserTracingIntegration({
        // Mark long-running attendance / approval transactions but don't
        // break navigation timings on mobile Safari.
        enableInp: true,
      }),
      Sentry.replayIntegration({
        // Strict redaction defaults — every text node and every media element
        // is masked/blocked. Attendance face photos, employee names, HR IDs,
        // wallet balances, penalty amounts, and DOB fields are never sent.
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
        // Belt-and-braces: also block anything explicitly tagged as sensitive.
        block: [
          '[data-attendance-photo]',
          '[data-private]',
          'img[src^="data:image"]',
          'video',
          'canvas',
        ],
        mask: [
          '[data-private]',
          'input',
          'textarea',
          '[data-employee-name]',
          '[data-wallet-amount]',
        ],
        // Don't capture XHR/fetch payloads in the replay — body scrubbing on
        // the SDK is best-effort and attendance/auth bodies are highly sensitive.
        networkDetailAllowUrls: [],
        networkCaptureBodies: false,
        networkRequestHeaders: ['x-request-id'],
        networkResponseHeaders: ['x-request-id'],
        mutationLimit: 5000,
        stickySession: false,
        useCompression: true,
      }),
    ],
  })
}
