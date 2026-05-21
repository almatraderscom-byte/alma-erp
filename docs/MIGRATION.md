# Sheets → Postgres Operational Migration

Status: **Phase 1 in production** (Sheets-before-DB bug eliminated for the
only operational hot path; indexes added; mirror is async best-effort).

This document is the binding contract for the staged migration of Alma ERP's
operational flows off Google Sheets and onto Supabase/Postgres. It is
deliberately conservative — the user explicitly mandated:

> Favor stability over cleverness. No unsafe refactors. No speculative
> rewrites. No breaking API contracts.

If a future engineer is tempted to "just rewrite payroll", read this file
first.

## TL;DR — current state

| Module | Postgres ownership | GAS still involved | Phase 1 ships? |
|---|---|---|---|
| Attendance (check-in/out, waivers, photos) | Full | No | No change needed |
| Selfie verification metadata | Full | No | No change needed |
| Penalty appeals | Full | No | No change needed |
| Approvals — wallet / penalty / trade | Full | No | No change needed |
| Approvals — **SALARY_ADVANCE** | Partial | **Yes** (`hr_payroll_add`) | **YES — order reversed: Postgres-first, Sheets is async mirror** |
| Payroll wallet requests (create/approve/reject) | Full | No writes | No change needed |
| Payroll wallet **admin summary** | Full | Reads `hr_employees` for HR roster enrichment (read-only) | **Phase 2** (Postgres roster source) |
| Telegram notification queue | Full | No | No change needed |

## Phase 1 — Ship now (this PR)

### What changed

1. **`src/lib/payroll-sheets-mirror.ts` (new)** — `mirrorSalaryAdvanceToSheets()`:
   - 15s hard timeout on `serverPost('hr_payroll_add', …)`
   - Returns `{ ok, mirrored, error?, latencyMs }`; never throws
   - Failures emit `payroll.gas_sheets_push.failed` (critical Sentry event)

2. **`src/app/api/approvals/[id]/route.ts::processSalaryAdvance`** — reversed
   the order of operations:
   - Old: `await serverPost('hr_payroll_add', …)` → DB update → approval resolve
   - New: DB update → approval resolve → `await mirrorSalaryAdvanceToSheets(…)`
   - GAS failure no longer leaves the salary advance row in `PENDING`.

3. **`src/app/api/advances/[id]/route.ts::PATCH` (legacy)** — same reversal.

4. **`prisma/schema.prisma` + migration `20260524000000_phase1_perf_indexes`**:
   - `AttendanceRecord(businessId, checkInAt)` — backs the
     `/api/attendance/check-in/health` range query.
   - `TelegramNotificationQueue(status, updatedAt)` — backs the
     stuck-`SENDING` reclaim probe in `processTelegramNotificationQueue`.

5. **`src/lib/sentry/capture.ts`** — `payroll.gas_sheets_push.failed` added to
   `CRITICAL_EVENT_PATTERNS`.

6. **`src/app/api/debug/runtime-health/route.ts`** — new benchmark fields:
   - `benchmarks.attendanceCountMs`
   - `benchmarks.approvalsPendingCountMs`
   - `benchmarks.telegramQueueCountMs`
   - `approvals.pending` snapshot

### What did NOT change

- No UI rewrite, no route contracts changed.
- The Sheets HR payroll book still receives `hr_payroll_add` POSTs (now
  async mirror, no longer the source of truth).
- Wallet summary admin enrichment still reads `hr_employees` (read-only,
  Phase 2).
- Telegram queue `TelegramNotificationStatus` enum still has 5 values
  (`QUEUED`, `SENDING`, `SENT`, `FAILED`, `SKIPPED`). The user-spec'd
  `PROCESSING` ≡ `SENDING` and `RETRYING` ≡ `QUEUED + attempts > 0 +
  nextAttemptAt > now`. See _Queue lifecycle mapping_ below.
- Existing regression gates (`regression:gate`, `attendance-regression-smoke`,
  `attendance-widget-regression-smoke`, `attendance-photo-telegram-smoke`,
  `attendance-production-verify`) are untouched.

## Queue lifecycle mapping (user-spec ↔ implementation)

| User-spec status | Implementation |
|---|---|
| `QUEUED` | `TelegramNotificationStatus.QUEUED` (new row, `attempts = 0`, `nextAttemptAt = null`) |
| `PROCESSING` | `TelegramNotificationStatus.SENDING` + `processingStartedAt = now()` |
| `SENT` | `TelegramNotificationStatus.SENT` (terminal) |
| `FAILED` | `TelegramNotificationStatus.FAILED` (terminal after `attempts >= maxAttempts` or non-retryable error) |
| `RETRYING` | `TelegramNotificationStatus.QUEUED` + `attempts > 0` + `nextAttemptAt` in the past |

Adding `PROCESSING` and `RETRYING` as new enum values would require a
non-trivial Prisma migration on a live production table and a sweep across
every status check in the cron worker, admin tooling, and regression gates.
Phase 1 keeps the semantic mapping above and documents it. Phase 3 may add
them if dashboard clarity becomes a problem.

Existing fields backing the lifecycle:

- `attempts` (default 0)
- `maxAttempts` (default 4) — `MAX_ATTEMPTS` constant in `queue.ts`
- `nextAttemptAt` — set via exponential backoff `[1, 5, 15, 60]` minutes
- `processingStartedAt` — set on `SENDING` claim; cleared on terminal
- `STUCK_SENDING_MS = 2 * 60_000` — reclaim cutoff

## Indexes (Phase 1)

Both indexes are added via `CREATE INDEX IF NOT EXISTS`, which is online for
small/medium tables (sub-second locks). Live row counts at the time of
writing make this safe.

- `AttendanceRecord_businessId_checkInAt_idx (businessId, checkInAt)`
- `TelegramNotificationQueue_status_updatedAt_idx (status, updatedAt)`

If a future operator wants ironclad zero-lock additions on huge tables, swap
to `CREATE INDEX CONCURRENTLY` in a hand-applied SQL migration; do not run it
inside a Prisma transaction.

## Phase 2 — Postgres-first reads (next PR, **not in this PR**)

1. **Wallet summary admin enrichment** — replace `serverGet('hr_employees', …)`
   with a Postgres query against `User` + `EmployeeProfile` (if columns
   exist) or `TradingEmployeeProfile`. Acceptance: identical UI; same
   columns; Sheets fallback ONLY if Postgres returns 0 rows AND the request
   is by SUPER_ADMIN.

2. **Wallet penalty/attendance dashboards** — short-TTL HTTP `Cache-Control`
   already present. Add `revalidateTag` for selective invalidation after
   mutations.

3. **Salary advance UI** — surface the new `warning` field when a Sheets
   mirror fails so HR can re-push from the admin payroll tools.

4. **Telegram queue retry hardening** — add admin "Retry stuck" button that
   maps to existing `/api/operations/system-diagnostics POST { action:
   'retry_failed' }`.

5. **Penalty appeal attachments** — migrate `AttendanceWaiverRequest
   .attachmentDataUrl` from inline base64 to `alma-storage:` refs. Backfill
   script + dual-read on the API.

## Phase 3 — Operational dependency on Sheets removed

- Salary advance: write a native Postgres ledger entry as the canonical
  record; keep Sheets as a nightly export (`runPayrollAccrual` cron already
  exists). Remove `hr_payroll_add` POST entirely. Replace the wallet summary
  GAS read with native Postgres.

- `hr_employees`, `hr_payroll`, `hr_dashboard` GAS routes become
  reporting-only (HR uses Sheets to view payroll snapshots, not to mutate
  state).

- Telegram lifecycle: optionally add `PROCESSING` and `RETRYING` as
  user-spec enum values; do this in a single migration paired with code
  changes everywhere `SENDING` is checked.

- Delete `mirrorSalaryAdvanceToSheets` and `serverPost('hr_payroll_add', …)`.

## Rollback

### Phase 1 rollback (this PR)

If `payroll.gas_sheets_push.failed` is firing in storm volumes AND the
fallback Sheets push is the right place to retry:

1. **Code rollback**:
   ```bash
   git revert <commit-sha-of-phase-1>
   git push origin main
   ```
   This restores Sheets-before-DB ordering AND removes the indexes. Indexes
   removal is harmless (the queries still work, just slower).

2. **Schema rollback** (only if the indexes themselves cause trouble, which
   is unlikely):
   ```sql
   DROP INDEX IF EXISTS "AttendanceRecord_businessId_checkInAt_idx";
   DROP INDEX IF EXISTS "TelegramNotificationQueue_status_updatedAt_idx";
   ```
   Run from `psql` against the production DB; not destructive.

3. **Salary advance reconciliation**:
   - Postgres rows that flipped to `APPROVED` but never made it into Sheets
     are visible by querying `payroll.gas_sheets_push.failed` in Logtail
     (last 30 days). Each event includes `advanceId`, `approvalId`,
     `businessId`, `empId`, `amount`.
   - For each affected row: re-POST `hr_payroll_add` with the same payload
     via the admin payroll tools, OR use `npx tsx scripts/replay-salary-advance-mirror.ts <advanceId>`
     (not built yet; trivial to add when needed).

### Phase 2 rollback

Phase 2 is read-replacement; the rollback is a single revert that restores
the GAS reads.

### Phase 3 rollback

Phase 3 deletes `hr_payroll_add`. The rollback strategy is the same as
Phase 1's reconciliation plus re-introducing `mirrorSalaryAdvanceToSheets`.

## Queue recovery (already shipped)

- Stuck `SENDING` rows older than 2 minutes are reclaimed to `QUEUED` at the
  start of every queue drain (`reclaimStuckTelegramSendingRows`).
- Stuck count is logged via `telegram.queue.stuck` (critical Sentry event,
  see `src/lib/sentry/capture.ts`).
- Delivery timeouts emit `telegram.delivery.timeout` (critical).
- Admin retry endpoints:
  - `POST /api/operations/system-diagnostics { action: 'retry_failed' }`
  - `POST /api/operations/system-diagnostics { action: 'retry_single', id }`
  - `POST /api/operations/system-diagnostics { action: 'process_queue' }`
- Cron: `/api/cron/telegram-notifications` runs every 10 minutes.

## Regression updates

- No regression script changes in Phase 1. The existing gates already cover:
  - Attendance idempotent commit (`attendance-photo-telegram-smoke.mjs`)
  - Awaited Telegram enqueue (`attendance-photo-telegram-smoke.mjs`)
  - Storage ref encoding (`attendance-photo-telegram-smoke.mjs`)
  - Approval action lifecycle (`mobile-runtime-regression-smoke.mjs`)
  - Production attendance latency (`attendance-production-verify.mjs`)
- Phase 2 will add a regression for the new Postgres roster query.

## Performance benchmarks

### Before (audit timing samples)

| Endpoint | p50 | p95 |
|---|---|---|
| `attendance/check-in` validation | 320ms | 392ms |
| Production attendance verify (mixed) | 2475ms | 7701ms |

The 7701ms p95 was driven by `super_admin_attendance_list` which does
multiple paginated `findMany`s. The new `(businessId, checkInAt)` index
should bring the `attendance-health` endpoint sub-200ms, and the
`(status, updatedAt)` index removes the sequential scan on `SENDING` reclaim.

### After (target)

| Endpoint | Phase 1 target p95 |
|---|---|
| `attendance/check-in` total | < 1000ms |
| `approvals` PATCH | < 800ms |
| `telegram` enqueue (DB row insert only) | < 150ms |
| `/api/debug/runtime-health` benchmarks | reads < 100ms each |

Live `/api/debug/runtime-health` returns observed `benchmarks.*` values so
operators can verify post-deploy.

## Production deployment checklist

1. ✅ `npm run type-check`
2. ✅ `npm run build`
3. ✅ `REQUIRE_REGRESSION_AUTH=1 npm run regression:gate`
4. ✅ `git push origin main`
5. ✅ Wait for Vercel deploy. Verify `/api/health` returns the new
   `git_commit`.
6. ✅ Run `curl -H "Authorization: Bearer $CRON_SECRET" \
   https://<production-host>/api/debug/runtime-health` and confirm:
   - `prisma.reachable: true`
   - `telegramQueue.stuckSending` is `0` (or whatever the recovered count
     after the deploy)
   - `benchmarks.*` all sub-200ms
7. ✅ Approve a sentinel salary advance from a non-production employee and
   confirm:
   - Postgres `SalaryAdvanceRequest.status === 'APPROVED'`
   - `ApprovalRequest.status === 'APPROVED'`
   - HR payroll Sheet shows the row
8. ✅ Force a GAS outage scenario by temporarily revoking the GAS deploy
   secret in a staging environment and confirming:
   - Postgres `status === 'APPROVED'` still
   - Response includes `{ warning: "Salary advance approved in ERP. Mirror
     to payroll Sheets failed — re-push from admin payroll tools." }`
   - Sentry receives `payroll.gas_sheets_push.failed` event

## Risk assessment

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| GAS push fails after Postgres commit, HR doesn't notice | Medium | Medium | Sentry critical event + response `warning` field surfaces to admin UI |
| Index `CREATE` locks `AttendanceRecord` briefly | Low | Low | Tables are small; lock is sub-second; deploy off-peak if paranoid |
| Index `CREATE` locks `TelegramNotificationQueue` briefly | Low | Low | Same |
| Mirror helper has a bug → all advances mirror-fail | Low | Medium | Helper has 15s timeout, never throws; rollback is `git revert` |
| Phase 2/3 timing slips → Sheets stays as fallback longer | Medium | Low | No active risk; Phase 1 is stable on its own |
| Salary-advance approval flow has unknown UI consumers depending on `gas` field | Low | Low | Field still returned; new fields are additive |

## Files changed (Phase 1)

- `src/lib/payroll-sheets-mirror.ts` (new)
- `src/lib/sentry/capture.ts` (added critical pattern)
- `src/app/api/approvals/[id]/route.ts` (`processSalaryAdvance` rewritten)
- `src/app/api/advances/[id]/route.ts` (PATCH rewritten)
- `src/app/api/debug/runtime-health/route.ts` (benchmark fields)
- `prisma/schema.prisma` (2 new `@@index` directives)
- `prisma/migrations/20260524000000_phase1_perf_indexes/migration.sql` (new)
- `docs/MIGRATION.md` (this file, new)
