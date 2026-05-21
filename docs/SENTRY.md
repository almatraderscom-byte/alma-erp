# Sentry production monitoring — Alma ERP

## Overview

Sentry captures frontend runtime errors, API exceptions, Prisma failures,
Telegram delivery issues, approval transaction failures, attendance
side-effect failures, React hydration mismatches, and **Session Replay on
error** with strict PII / attendance-photo redaction. Sampling is tuned for
**minimal overhead** on Vercel serverless and mobile Safari / PWA.

## Environment variables (Vercel)

| Variable | Required | Description |
|----------|----------|-------------|
| `SENTRY_DSN` | Yes (prod) | Project DSN from Sentry |
| `NEXT_PUBLIC_SENTRY_DSN` | Yes (prod) | Same DSN for browser SDK |
| `SENTRY_ORG` | Build | Sentry org slug (source map upload) |
| `SENTRY_PROJECT` | Build | Project slug |
| `SENTRY_AUTH_TOKEN` | Build | Auth token with `project:releases` |
| `SENTRY_ENVIRONMENT` | Optional | Overrides `VERCEL_ENV` |
| `SENTRY_RELEASE` | Optional | Defaults to `VERCEL_GIT_COMMIT_SHA` |
| `SENTRY_TRACES_SAMPLE_RATE` | Optional | Default `0.05` production, `0.02` preview, `0` dev |
| `SENTRY_PROFILES_SAMPLE_RATE` | Optional | Default `0` (disabled) |
| `SENTRY_REPLAY_SESSION_SAMPLE_RATE` | Optional | Default `0` (no random replay sessions) |
| `SENTRY_REPLAY_ERROR_SAMPLE_RATE` | Optional | Default `0.2` (20% of error sessions) |
| `SENTRY_ENABLED` | Optional | Set `false` to disable without removing DSN |
| `SENTRY_DEBUG` | Optional | Set `true` to enable SDK debug logs |

Vercel integration: link the **Sentry integration** in the Vercel dashboard —
it provisions DSN + auth token + release automatically and points uploaded
source maps at the right Git SHA.

## Sampling (performance-safe)

| Surface | Production | Preview | Dev |
|---------|-----------|---------|-----|
| Error events | 100% (filtered by `beforeSend`) | 100% | 100% (when DSN set) |
| Performance traces | 5% | 2% | 0% |
| Session replay (random) | 0% | 0% | 0% |
| Session replay (on error) | 20% | 10% | 0% |
| Profiling | 0% | 0% | 0% |

Tune any rate via the env vars above — values are clamped to `[0, 1]`.

## Session Replay redaction (mobile-Safari-safe)

`sentry.client.config.ts` enables `replayIntegration` with:

- `maskAllText: true` — every text node masked (employee names, HR IDs, wallet, penalty amounts)
- `maskAllInputs: true` — every input/textarea masked
- `blockAllMedia: true` — every `<img>`, `<video>`, `<canvas>`, `<picture>` blocked
- Extra `block` selectors: `[data-attendance-photo]`, `[data-private]`, `img[src^="data:image"]`
- `networkCaptureBodies: false` and `networkDetailAllowUrls: []` — no fetch/XHR bodies in replays
- Only the `X-Request-Id` header is kept so you can correlate a replay to a structured server log

Attendance face preview images carry `data-attendance-photo` and `data-private`
markers as a second layer of defence in case any future change relaxes the
default `blockAllMedia` setting.

## `beforeSend` scrubbing (server + client)

The shared scrubber in `src/lib/sentry/config.ts` deep-walks every event and:

- Replaces `data:image/...;base64,...` with `data:image/...;base64,[Filtered]`
- Strips fields named `image_data_url`, `thumb_data_url`, `face_verification`,
  `face_image_data_url`, `attachmentDataUrl`, `attachmentDataUrls`,
  `password`, `passwordHash`, `token`, `authToken`, `apiKey`, `secret`,
  `sessionToken`, `cookie`, `authorization`, `phone`
- Detects Bearer tokens, Telegram bot tokens, and JWT-shaped strings and
  redacts them in place
- Truncates strings above 4 KB to control event size
- Runs over `event.request.data`, `event.extra`, `event.contexts.*`, and
  every breadcrumb's `data` and `message`

`beforeBreadcrumb` strips bodies and query strings from fetch/XHR
breadcrumbs hitting any attendance / profile-image / penalty-appeal endpoint
so even network breadcrumbs can never leak a face photo URL.

## User / request context

| Surface | Sets |
|---------|------|
| `SentryUserBridge` (client) | `user.id`, `user.email`, `user.username`, `user.role`, `user.business_access`, `business.id` |
| `withApiRoute` (server) | `route`, `request.id` (from `X-Request-Id` header) |
| `prisma.$extends` ($allOperations) | `prisma.query.failed` events with `model`, `operation` |
| `AttendanceWidgetErrorBoundary` (client) | `boundary`, `surface=attendance_widget`, `attendanceBoundary.componentStack` |
| `AttendanceSubsectionBoundary` (client) | `boundary=attendance_subsection:{name}`, `surface=attendance_subsection` |

No passwords, session tokens, or attendance photos are sent.

## Critical ERP events (alert targets)

Structured logs are forwarded to Sentry when they match the
`CRITICAL_EVENT_PATTERNS` in `src/lib/sentry/capture.ts`:

| Pattern | Category | Examples |
|---------|----------|----------|
| `approval.(tx.\|action.failed\|execute_failed\|api.failed)` | `approval` | approval workflow failures |
| `telegram.(cron.\|deliver.\|queue.\|owner.routing)` | `telegram` | queue / cron / delivery errors |
| `*.failed` | varies | any handler emitting `.failed` |
| `attendance.api.failed` | `attendance` | uncaught attendance API exceptions |
| `attendance.telegram_event_missing` | `attendance` | check-in Telegram queue insert lost |
| `attendance.checkin.transaction_failed` | `attendance` | atomic transaction rolled back |
| `attendance.checkin.side_effect_failed` | `attendance` | post-response side effect failed |
| `archive.filter.failed` | `archive` | business-archive query failure |
| `orders.provider.missing` | `orders` | orders/CRM context broken |
| `database_error` / `prisma.*` | `prisma` | Prisma client errors |

## Recommended Sentry alert rules

Create in Sentry → Alerts → Create Alert:

1. **Critical ERP — errors**
   - When: `event.level = error` AND `tags[critical] = true`
   - Action: Slack / email / PagerDuty
2. **Attendance reliability**
   - When: `event.tags[category] = attendance`
   - Threshold: 3 events in 5 minutes
3. **Approval failures**
   - When: `event.tags[category] = approval` AND `event.level = error`
   - Threshold: 3 events in 5 minutes
4. **Telegram delivery**
   - When: `event.tags[category] = telegram`
   - Threshold: 5 events in 10 minutes
5. **Database / Prisma**
   - When: `event.tags[category] = prisma`
   - Threshold: 10 events in 5 minutes
6. **Hydration regressions**
   - When: `event.tags[category] = hydration`
   - Threshold: 1 event (immediate)

## Releases & source maps

On `npm run build` with `SENTRY_AUTH_TOKEN` set (Vercel build environment),
`@sentry/nextjs`:

- Uploads source maps and associates them with `VERCEL_GIT_COMMIT_SHA`
- Sets the release name on every event automatically
- Uses `widenClientFileUpload: true` so all client chunks are mapped
- Uses `hideSourceMaps: true` so maps are never served from the public bundle

Verify in **Sentry → Releases** after a deploy; the new SHA should appear
within ~2 minutes of the Vercel build finishing.

## PWA / Service worker safety

`public/sw.js` returns early for any non-`GET` request, so the Sentry
tunnel route `/monitoring` (POST) is **never intercepted** by the cache.
The same guard prevents the service worker from caching `/api/*` requests,
including the Sentry envelope endpoint.

## Local development

Sentry is **off** unless `SENTRY_DSN` is set. To test locally:

```bash
SENTRY_DSN=https://...@sentry.io/...
NEXT_PUBLIC_SENTRY_DSN=$SENTRY_DSN
SENTRY_DEBUG=true npm run dev
```

Trigger a captured event:

```bash
curl -X POST http://localhost:3000/api/_sentry-test
# or render a throwing element under an AttendanceSubsectionBoundary
```

## Tunnel route

Browser events route through `/monitoring` (configured in `next.config.js`)
to reduce ad-blocker drops. This is a same-origin POST, so it always passes
CORS / SameSite-Strict cookies / iOS Safari ITP.

## Dashboard URLs

After Vercel deploys, your Sentry project surfaces:

| View | URL pattern |
|------|-------------|
| Issues | `https://<org>.sentry.io/issues/?project=<projectId>&environment=production` |
| Replays | `https://<org>.sentry.io/replays/?project=<projectId>` |
| Releases | `https://<org>.sentry.io/releases/?project=<projectId>` |
| Performance | `https://<org>.sentry.io/performance/?project=<projectId>` |
| Alerts | `https://<org>.sentry.io/alerts/rules/?project=<projectId>` |

Bookmark the Issues filter `tags[surface]:attendance_widget` for the
attendance reliability dashboard.
