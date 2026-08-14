/**
 * Browser-side Sentry init.
 *
 * This file replaces `sentry.client.config.ts`, which Next 16 (Turbopack builds)
 * no longer loads — the SDK's own words: "When using Turbopack
 * `sentry.client.config.ts` will no longer work." The Next 14 → 16 upgrade on
 * 2026-08-09 therefore silenced every browser error report; Sentry's last event
 * of any kind is 2026-08-08 19:02, and a live check on production found the SDK
 * bundle loaded but `getClient()` undefined. Keep the init here.
 *
 * Redaction rules below are unchanged from the old client config — attendance
 * face photos, employee names, HR ids, wallet balances and request bodies must
 * never leave the device.
 */
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

/** App Router navigation spans — required since Sentry v9 / Next 15. */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
