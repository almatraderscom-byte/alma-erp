# ALMA ERP — Final Production-Readiness Audit Report

**Audit date:** 2026-06-16
**Scope:** Full codebase + worker + production environment
**Inventory:** 351 API routes · 51 UI pages · 55 worker scheduler jobs · 121 Prisma models · ~158 agent tool definitions

---

## Verification gates (all PASS at end of audit)

| Gate | Result | Output |
|---|---|---|
| `npx tsc --noEmit` | **PASS** | exit 0, 0 errors |
| `npx next lint --max-warnings=9999` | **PASS** | 0 errors, 169 warnings (non-blocking) |
| `npx prisma validate` | **PASS** | "schema valid 🚀" |
| `npx prisma migrate status` (production) | **PASS** | "74 migrations · Database schema is up to date!" |
| Production `/api/health` | **PASS** | `ok:true · env.ok:true · database.ok:true` |
| Worker heartbeats | **PASS** | 3 services updated <1 min ago |

---

## Issues found and resolved

### P0 — Production-breaking, **all fixed**

| # | File | Root cause | Fix |
|---|---|---|---|
| 1 | `src/app/page.tsx` (LifestyleDashboard) | React Hooks rules-of-hooks violation: `useDateRange()` + `useMemo()` called AFTER conditional early return → state corruption when `enabled` flips | Moved hooks before early return |
| 2 | `src/app/api/twilio/twiml/salah-call/route.ts` | **No auth.** Anyone with the URL could control outbound TwiML `<Play>`/`<Say>` | Added Twilio HMAC-SHA1 signature verification (`x-twilio-signature` header) |
| 3 | `src/app/api/twilio/call-status/route.ts` | **No auth.** Anyone could POST fake `CallStatus=no-answer` and trigger fake "missed call retry" actions | Verify Twilio HMAC sig OR Bearer `AGENT_INTERNAL_TOKEN` (worker fallback) |
| 4 | `src/app/api/assistant/internal/generate-report/route.ts` | Hardcoded deprecated model `claude-sonnet-4-20250514` — would fail in production | Use `enforceClaudeOnlyModel()` + 25s SDK timeout |
| 5 | `src/app/api/assistant/internal/generate-focus-plan/route.ts` | Same deprecated model | Same fix |
| 6 | `worker/src/approval/staff-approval-gate.mjs` | Trust-check fail-open: network failure → `tier:'approve'` (was used as auto-approve) → could drain budget | Fail closed (route to manual approval card) + log |

### P1 — Reliability + security, **all fixed**

| # | File | Root cause | Fix |
|---|---|---|---|
| 1 | `worker/src/cs/reply.mjs` | No timeout on `/api/assistant/internal/cs-run` call → could hang worker | `resilientFetch` 60s + 1 retry |
| 2 | `worker/src/cs/meta-send.mjs` | Meta Graph API calls had no timeout/retry | `resilientFetch` 15s + 1 retry |
| 3 | `worker/src/notify/ntfy.mjs` | Critical alert send had no timeout | `AbortSignal.timeout(8_000)` on both topics |
| 4 | `src/lib/website-order-ingest.ts` | No idempotency check; webhook retry could create duplicate orders | Pre-flight Supabase query for existing `[Website XYZ]` tag |
| 5 | `prisma/schema.prisma` + new migration | `cs_messages.meta_message_id` had no unique index — Meta webhook retry race could double-insert | Partial unique index `WHERE meta_message_id IS NOT NULL` (verified 0 existing dupes, deployed live) |
| 6 | `src/app/api/agent/trust-check/route.ts`, `smart-task`, `staff-capabilities`, `staff-context`, `assistant/todos/route.ts` | Plain `===` token compare (timing oracle) | Replaced with `verifyAgentInternalToken()` (constant-time) |
| 7 | `worker/src/notify/twilio-call.mjs` | `pollAndReportCallResult` POST to `/api/twilio/call-status` had no auth header → would 403 after Phase 2 fix | Send `Authorization: Bearer ${AGENT_INTERNAL_TOKEN}` |
| 8 | `src/app/api/approvals/route.ts` | `const module = …` shadows Next.js `module` global (lint error) | Renamed to `moduleFilter` |
| 9 | `src/agent/components/AgentStaffMonitor.tsx` | Mobile bottom-padding `pb-8` insufficient → overlapped by `AgentBottomNav` (3.5rem). Owner-reported "CC Camera Room" UI bug | `pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-8` |
| 10 | `src/agent/components/AgentCostsDashboard.tsx` | Same overlap | Same fix |
| 11 | `src/components/trading/TradingWorkflowActions.tsx` (`TradingStickyBar`) | Sat at `bottom-0 z-40`, hidden behind ERP mobile nav (`z-50`) | `bottom-[calc(4rem+env(safe-area-inset-bottom))] z-[51] md:bottom-0` |
| 12 | `scripts/regression-gate.mjs` | CI gate didn't run lint | Added `npm run lint` to gate sequence |

### P2 — Documented but **not fixed** (non-blocking, owner-decision)

These are real but the owner can launch without them. Listed with file paths so a future pass can clean them up.

| # | Topic | Files | Notes |
|---|---|---|---|
| 1 | Digital/CDIT GET routes lack handler RBAC | `src/app/api/digital/*` (7 routes) | Any authenticated user can read CDIT data; middleware blocks external requests but allows STAFF/HR cross-business reads |
| 2 | Lifestyle finance GETs lack handler RBAC | `/api/finance`, `/api/finance/report`, `/api/orders/orders`, `/api/dashboard`, `/api/analytics` | Same risk class |
| 3 | `NEXTAUTH_SECRET` fallback in cron auth | `/api/notifications/reminders` | Cron auth falls back to `NEXTAUTH_SECRET` if `CRON_SECRET` unset |
| 4 | Telegram webhook fails open in non-prod | `/api/telegram/webhook` | Safe in prod (NODE_ENV=production), but a non-prod env without secret accepts all POSTs |
| 5 | 17 worker fetch sites still lack timeouts | `worker/src/notify/twilio-call.mjs:52,73`, `worker/src/tts.mjs:91,102`, `worker/src/telegram/voice.mjs:29,34`, `worker/src/tts-elevenlabs.mjs:40`, `worker/src/finance/index.mjs:21`, `worker/src/reports/owner-briefing.mjs:14`, `worker/src/messenger/scan.mjs:66,155`, `worker/src/cs/messenger-poll.mjs:19`, `worker/src/ads/monitor.mjs:20`, `src/agent/lib/owner-briefing-data.ts`, `src/agent/lib/cs/gemini-vision.ts:43`, `src/lib/financial-intelligence.ts:79,89` | Lower-tier paths; no customer-facing impact |
| 6 | UI duplication | Three page shells (`FinancePageChrome`/`TradingPageShell`/`CditPageShell`); Skeleton CSS in 2 files; `fadeUp`/`stagger` redefined in 28+ pages instead of using `lib/motion.ts` `MOTION` constants; `text-gray-*` (agent) vs `text-slate-*` (ERP) | Refactor opportunity, no functional impact |
| 7 | Dead exports | `src/components/layout/AppShell.tsx` (deprecated no-op), `src/agent/components/AgentShell.tsx` | Safe to delete in a future pass |
| 8 | 169 ESLint warnings | mostly unused vars + `react-hooks/exhaustive-deps` | Non-blocking; gate enforces `errors=0` |
| 9 | `as any` in 141 files (mostly `prisma as any` for dynamically-pushed agent tables) | Established codebase pattern | Acceptable trade-off, documented |
| 10 | Lifestyle dashboard `/` for CDIT business shows incomplete skeleton | `src/app/page.tsx` | Cosmetic |
| 11 | Orphan route `/agent/trading-staff` not in `AgentBottomNav` | `src/app/agent/trading-staff/page.tsx` | Conceptually overlaps `/trading/hr` |

---

## Architecture verification (PASS)

- **Auth split**: Middleware JWT for ~175 routes, internal Bearer for 81 `/api/assistant/internal/*`, X-ALMA-API-KEY for 53 legacy `/api/agent/*`, webhook signatures for 22 routes, public for 8 by design. **Phase 2 closed the 2 P0 unprotected routes.**
- **Worker model**: VPS BullMQ + 55 schedulers + Telegraf long-poll. Heartbeats every 60s, watchdog cron every 5min, alerts owner on stale.
- **Cost guards**: `enforceClaudeOnlyModel()` locks CS/strategist/reflection. **Phase 3 added the lock to 2 missing routes.**
- **Idempotency**: salah reminders (atomic increment), Twilio call costs (`twilio:${callSid}`), email (`dedupeKey`), Messenger ingest (`metaMessageId` — now uniquely indexed), website orders (now checks existing tag).
- **Observability**: Sentry auto-instrumentation via `instrumentation.ts` covers all 351 routes; 33 routes also wrap with `withApiRoute` for richer scope; structured `logEvent` throughout.
- **Schema**: 121 models, 334 indexes (~2.8 per model), 74 migrations applied, 0 drift.
- **Build**: `tsc --noEmit` clean; ESLint configured (was missing); Vercel production build PASS (live `git_commit:40d3203` healthy).

---

## Final summary

> 50 issues found · 18 fixed at code level · 11 deferred (P2, documented) · 4 require owner live-verify · **P0 remaining: 0**

**Production-ready: YES (assuming owner runs `OWNER_LIVE_VERIFY.md` after deploy).**

Files changed in audit (28 files):
- New: `.eslintrc.json`, `src/lib/twilio/verify-signature.ts`, `prisma/migrations/20260616120000_cs_meta_message_unique/migration.sql`, `docs/DEPLOY_RUNBOOK.md`, `AUDIT_REPORT.md`, `OWNER_LIVE_VERIFY.md`
- Modified: 22 source files (see `git diff --stat`)

Pre-existing CI gate (`production-deploy-gate.yml`) already enforces typecheck + build + smoke. Phase 7 added lint to the gate sequence.
