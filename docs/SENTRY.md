# Sentry production monitoring — Alma ERP

## Overview

Sentry captures frontend runtime errors, API exceptions, Prisma failures, Telegram delivery issues, approval transaction failures, and React hydration mismatches. Sampling is tuned for **low overhead** on Vercel serverless.

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
| `SENTRY_TRACES_SAMPLE_RATE` | Optional | Default `0.05` production, `0` dev |
| `SENTRY_PROFILES_SAMPLE_RATE` | Optional | Default `0` (disabled) |
| `SENTRY_ENABLED` | Optional | Set `false` to disable without removing DSN |

Vercel integration: link the Sentry integration in Vercel dashboard — it sets DSN + auth token + release automatically.

## Sampling (performance-safe)

- **Errors:** 100% of captured events (filtered by `beforeSend` for noise)
- **Performance traces:** 5% production, 2% preview, 0% local
- **Session replay:** disabled (`0`)
- **Profiling:** disabled

## User / session context

`SentryUserBridge` sets:

- `user.id`, `user.email`, `user.username`
- Tags: `user.role`, `user.business_access`, `business.id`

No passwords or session tokens are sent.

## Critical ERP events (alert targets)

Structured logs with `level: error` (and selected Telegram warnings) are forwarded to Sentry with tags:

| Tag | Examples |
|-----|----------|
| `category=approval` | `approval.tx.*`, `approval.action.failed`, `approval.api.failed` |
| `category=telegram` | `telegram.deliver.*`, `telegram.cron.*`, `telegram.queue.*` |
| `category=prisma` | Prisma query failures |
| `category=api` | `withApiRoute` uncaught exceptions |
| `category=hydration` | `global-error` hydration detection |

## Recommended Sentry alert rules

Create in Sentry → Alerts → Create Alert:

1. **Critical ERP — errors**  
   - When: `event.level = error` AND `tags[critical] = true`  
   - Action: Slack / email / PagerDuty

2. **Approval failures**  
   - When: `event.tags[category] = approval` AND `event.level = error`  
   - Threshold: 3 events in 5 minutes

3. **Telegram delivery**  
   - When: `event.message` contains `telegram.` AND `event.level = error`  
   - Threshold: 5 events in 10 minutes

4. **Database / Prisma**  
   - When: `event.tags[category] = prisma`  
   - Threshold: 10 events in 5 minutes

5. **Hydration regressions**  
   - When: `event.tags[category] = hydration`  
   - Threshold: 1 event (immediate)

## Source maps & releases

On `npm run build` with `SENTRY_AUTH_TOKEN` set, `@sentry/nextjs` uploads source maps and associates them with `VERCEL_GIT_COMMIT_SHA`.

Verify in Sentry → Releases after deploy.

## Local development

Sentry is **off** unless `SENTRY_DSN` is set. To test locally:

```bash
SENTRY_DSN=https://...@sentry.io/...
NEXT_PUBLIC_SENTRY_DSN=$SENTRY_DSN
SENTRY_DEBUG=true npm run dev
```

## Tunnel route

Browser events may use `/monitoring` tunnel (configured in `next.config.js`) to reduce ad-blocker drops.
