# Supabase Region Alignment Plan

Status: **PLAN ONLY — DO NOT EXECUTE WITHOUT EXPLICIT OPERATOR APPROVAL.**

This document is the binding plan for relocating the Alma ERP Supabase
project from `ap-northeast-1` (Tokyo) to a region co-located with Vercel
`iad1` (US East). Phase 3 of the production hardening rollout explicitly
forbids the migration in this turn — only the plan, risk analysis, and
validation checklist are produced now.

---

## 1. Current state (measured)

| Component | Region | Notes |
|---|---|---|
| Vercel functions | `iad1` (Ashburn, VA, US East) | Confirmed via `VERCEL_REGION` env var in `/api/debug/runtime-health` |
| Supabase Postgres pooler | `aws-1-ap-northeast-1.pooler.supabase.com` (Tokyo) | Confirmed via `DATABASE_URL` in `.env` and the same hostname is present in Vercel prod env |
| Supabase Storage buckets | `nrkuzcorcpcwrkckbeoq.supabase.co` (Supabase storage edge resolves regionally) | Same project ref `nrkuzcorcpcwrkckbeoq` |
| Sentry | Region-independent (sentry.io ingestion) | No change required |
| Telegram | Region-independent | No change required |

### Measured latency (live production, post-Phase 1)

| Probe | Cold | Steady-state warm |
|---|---|---|
| `SELECT 1` RTT (Prisma ping) | 2036 ms / outlier 4851 ms | **748 ms** |
| Single `COUNT(*)` query | 1450–2898 ms | **748 ms** |
| 13-query parallel batch | 10–30 s elapsed | ~10 s elapsed (pool-serialized) |

The steady-state warm RTT of **~748 ms is the network floor** between
Vercel iad1 and Supabase Tokyo. Postgres execution itself is sub-ms; the
entire cost is network. This caps every product-level perf target.

### Implication

| Spec target | Achievable from current geometry? |
|---|---|
| Attendance response < 1s | Yes (batched in 1–2 RTTs) |
| Approval actions < 800ms | Yes (warm) |
| Dashboard load < 2s | Yes (with HTTP cache) |
| Telegram enqueue < 150ms | **No — single insert is ~750 ms net** |

Relocating Supabase to `us-east-1` (which colocates with Vercel iad1)
brings the floor to ~5–15 ms. This is the single highest-leverage
infrastructure change available to the ERP.

---

## 2. Target architecture

| Component | Target region | Reason |
|---|---|---|
| Supabase Postgres pooler | `aws-1-us-east-1` (Virginia) | Same DC as Vercel iad1 |
| Supabase Storage | `us-east-1` (Supabase resolves to the project region) | Photo signed URLs latency drops in lockstep |
| Vercel functions | `iad1` (unchanged) | No change |

Alternative: keep Supabase in Tokyo and relocate Vercel functions to
`hnd1` (Tokyo). Less attractive because the Vercel dashboard, Sentry,
and most of the operator base are in US/EU. iad1 + us-east-1 is the
canonical default.

---

## 3. Migration procedure (Supabase project migration)

Supabase **does not** provide an in-place region change. The migration
is a full project export + import:

1. **Pre-flight**
   - Verify nightly Supabase backups completed within the last 12 h.
   - Confirm `prisma migrate status` shows ZERO pending migrations against
     prod (`/Users/marufbillah/alma-erp/prisma/migrations/`).
   - Capture a snapshot of `Cache-Control`, `Webhook`, and `Storage`
     settings via Supabase dashboard (no API; screenshot is fine).
   - Inventory current secrets (see § 4).
   - Notify employees: announce a maintenance window (recommend 30 min,
     execute it in 10 min).

2. **Create the destination project**
   - Supabase dashboard → "New project" → region `us-east-1`. Use the
     same plan tier as production (Pro). Wait for provisioning (~3 min).
   - Note the new project ref `XXXXXX`, `DATABASE_URL`, `SUPABASE_URL`,
     anon key, service role key.

3. **Schema + data migration**
   - **Schema:** run `npx prisma migrate deploy` against the new project
     (uses the same `prisma/migrations/` directory). This must complete
     with no diff between old and new schemas.
   - **Data:** the recommended path is Supabase's "Migration API" if
     available on the Pro tier; if not, use logical replication:
     ```bash
     pg_dump --no-owner --no-acl --clean --if-exists \
       --exclude-schema=storage --exclude-schema=auth \
       "$OLD_DATABASE_URL" > erp-data.sql
     psql "$NEW_DATABASE_URL" < erp-data.sql
     ```
     **DO NOT skip `--exclude-schema=storage --exclude-schema=auth`** —
     these are Supabase-managed and must be migrated through Supabase's
     own mechanisms.

4. **Auth migration**
   - Use Supabase's "Auth migration" tool (Dashboard → Auth → Migration)
     to copy users + sessions from the old project. This preserves
     user IDs (required, since `User.id` is the FK on every table).
   - Validate by signing in as a known SUPER_ADMIN against the new
     project before cutover.

5. **Storage migration**
   - Use Supabase's "Storage migration" mechanism. Buckets to migrate:
     - `expense-receipts` (selfies + verification photos)
     - any branding/asset buckets currently in use
   - Validate: list a sample of objects and download one via signed URL
     against the new project before cutover.

6. **Cutover (the 10-min window)**
   - Vercel env vars to update (Project → Settings → Environment Variables):
     - `DATABASE_URL` → new project pooler
     - `DIRECT_URL` → new project direct
     - `SUPABASE_URL`
     - `NEXT_PUBLIC_SUPABASE_URL`
     - `SUPABASE_SERVICE_ROLE_KEY`
     - `SUPABASE_ANON_KEY` (if used)
     - `NEXT_PUBLIC_SUPABASE_ANON_KEY` (if used)
   - Trigger a new Vercel deploy.
   - DO NOT change `CRON_SECRET`, `NEXTAUTH_SECRET`, `SENTRY_DSN`, or
     `TELEGRAM_BOT_TOKEN`. These are region-independent.

7. **Post-cutover validation** (within 5 min of cutover):
   - `curl /api/health` returns `prisma.reachable: true`
   - `curl -H "Authorization: Bearer $CRON_SECRET" /api/debug/runtime-health`
     shows:
     - `geometry.lambdaRegion: "iad1"`
     - `geometry.dbRegion: "us-east-1"`
     - `geometry.regionsAligned: true`
     - `geometry.networkRttFloorMs` < 50 ms
     - `prisma.pingMs` < 50 ms
     - `benchmarks.*` all < 50 ms each
   - Sign in as a regular employee, complete a check-in with face capture.
   - Approve a sentinel salary advance (smoke test).
   - Verify a Telegram notification fires within 10 minutes (queue cron).
   - Confirm `/api/operations/system-diagnostics` shows `stuckSending: 0`
     and `selfieStorage.missingStorageRefCount: 0`.

8. **Old project decommission** (after 7 days of stable operation):
   - Take a final `pg_dump` of the old project, archive offsite.
   - Pause the old Supabase project (do NOT delete for at least 30 days).

---

## 4. Secrets / env vars inventory

These MUST be updated atomically with the cutover deploy:

| Env var | Source | Notes |
|---|---|---|
| `DATABASE_URL` | Supabase dashboard → new project → pooler | Connection string |
| `DIRECT_URL` | Supabase dashboard → new project → direct | For `prisma migrate deploy` |
| `SUPABASE_URL` | Supabase dashboard → new project → URL | REST API base |
| `NEXT_PUBLIC_SUPABASE_URL` | Same as `SUPABASE_URL` | Client-side use |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → new project → service role | Server-only |
| `SUPABASE_ANON_KEY` | Supabase dashboard → new project → anon | If used |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Same as `SUPABASE_ANON_KEY` | Client-side |

These do NOT change:

| Env var | Reason |
|---|---|
| `CRON_SECRET` | Region-independent |
| `NEXTAUTH_SECRET` | Region-independent |
| `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` | Region-independent |
| `TELEGRAM_BOT_TOKEN` | Region-independent |
| `LOGTAIL_*` | Region-independent |
| `OPENAI_API_KEY`, etc. | Region-independent |

---

## 5. Downtime estimate

| Phase | Duration | Read-only? | Write-only? |
|---|---|---|---|
| Provision new project | ~3 min | N/A | Old project unaffected |
| Schema migration | ~2 min | N/A | Old project unaffected |
| Data dump | 5–20 min (depends on row count) | **Yes — set DB read-only at start of dump** | |
| Auth migration | ~2 min | Same | |
| Storage migration | 10–60 min (depends on object count) | Can run concurrently with dump | |
| Cutover deploy | ~2 min | **Brief 502s during deploy** | |
| Post-cutover validation | ~5 min | Live with reads | |

**Total operator-visible downtime: ~10 minutes** (the dump + cutover
window). Schedule for a low-traffic period (early morning local time
for the employee base).

---

## 6. Risk analysis

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Data loss between dump and cutover (writes during dump) | High if window > 5 min | High | Set old DB to `DEFAULT_TRANSACTION_READ_ONLY=on` before dump; reject writes during window |
| Auth migration leaves orphan sessions | Low | Medium | Supabase auth migration preserves user IDs; users may need to re-login |
| Storage signed URLs continue to point at the old project | Low | Medium | Signed URLs have 1 h TTL by default; new URLs minted by `createSignedObjectUrl` after cutover hit the new project automatically |
| `pg_dump` includes `storage`/`auth` schemas and breaks the new project | Medium | High | Always use `--exclude-schema=storage --exclude-schema=auth` |
| Vercel env vars updated but cron secret regenerated by mistake | Low | High | `CRON_SECRET` is explicitly NOT touched (§ 4) |
| Prisma client cached connections to old DB after deploy | Low | Low | Vercel kills old lambdas on deploy; new lambdas connect to new DB |
| Old project deleted before stable | Low | Catastrophic | DO NOT delete for at least 30 days; pause instead |
| Telegram queue rows mid-flight during cutover | Medium | Low | Crons stop running during deploy; rows resume from QUEUED on first post-cutover cron tick (stuck-SENDING reclaim handles any abandoned rows automatically) |
| Sentry release tracking breaks correlation | Low | Low | Sentry uses git SHA, not region; correlation is preserved |
| Service Worker caches old API URLs (PWA) | Low | Low | API base is same-origin; no SW invalidation needed |

---

## 7. Rollback plan

**Trigger:** any of these conditions within 60 min of cutover:
- `prisma.reachable: false` for > 2 min
- `stuckSending > 5` and not draining
- `attendance-production-verify` regression script fails
- Sign-in fails for SUPER_ADMIN users
- Telegram queue drains less than 1 row per 10-min cron tick

**Procedure:**
1. Revert Vercel env vars to old project values (have them saved in a
   secure note before cutover).
2. Trigger a Vercel redeploy.
3. Old project automatically resumes (it was paused, not deleted).
4. Verify `/api/health` and `/api/debug/runtime-health` return to
   pre-cutover values (`geometry.dbRegion: "ap-northeast-1"`).
5. Diff the row counts of `AttendanceRecord`, `ApprovalRequest`,
   `WalletRequest`, `TelegramNotificationQueue` between old and new
   projects. Any rows created on the new project during the brief
   window must be replayed against the old project — typically zero
   if cutover was scheduled correctly.
6. File a follow-up ticket explaining what blocked the migration.

**Worst-case data divergence handling:** any write made during the
post-cutover window that ended up only in the new project is captured
by Postgres WAL on the new project. Reverse the migration by:
1. Dump the new project (only AttendanceRecord, ApprovalRequest,
   WalletRequest, TelegramNotificationQueue tables) with `--where` clauses
   filtering rows newer than cutover time.
2. INSERT them into the old project using `ON CONFLICT DO NOTHING`.
3. Resume normal operation on the old project.

---

## 8. Validation checklist (pre-cutover)

- [ ] `npm run type-check` — clean
- [ ] `npm run build` — clean
- [ ] `REQUIRE_REGRESSION_AUTH=1 npm run regression:gate` — passes
- [ ] `/api/debug/runtime-health` shows zero stuck SENDING, zero stale FAILED, zero stale PENDING approvals
- [ ] No active long-running Telegram notifications waiting for delivery
- [ ] All recent migrations applied to OLD project (verify with `prisma migrate status`)
- [ ] Snapshot of all Vercel env vars (especially the secrets list in § 4) saved offline
- [ ] Maintenance window communicated to employees
- [ ] Sentry alert routing verified (we'll be sensitive to noise during cutover)
- [ ] Rollback secrets prepared (old project credentials in a secure note)

## 9. Validation checklist (post-cutover)

- [ ] `/api/health` returns OK with new SHA
- [ ] `/api/debug/runtime-health` shows:
  - [ ] `geometry.regionsAligned: true`
  - [ ] `geometry.networkRttFloorMs` < 50 ms
  - [ ] `prisma.pingMs` < 50 ms
  - [ ] `benchmarks.attendanceCountMs` < 50 ms
  - [ ] `benchmarks.approvalsPendingCountMs` < 50 ms
  - [ ] `benchmarks.telegramQueueCountMs` < 50 ms
  - [ ] `telegramQueue.stuckSending: 0`
  - [ ] `telegramQueue.staleFailed24h: 0`
  - [ ] `approvals.stalePending30d: 0`
- [ ] Sign in as SUPER_ADMIN — succeeds
- [ ] Sign in as a regular employee — succeeds
- [ ] Complete a face-verified check-in — selfie uploads, attendance row created, Telegram event fires within 10 min
- [ ] Approve a sentinel wallet request — Postgres row updated, Telegram notification queued
- [ ] Approve a sentinel salary advance — Postgres row updated, `payroll.gas_sheets_push.success` event fires (or `failed` with the new region's IP being accepted by GAS)
- [ ] `/api/operations/system-diagnostics` shows healthy queue + storage metrics
- [ ] `attendance-production-verify` regression script passes against new region
- [ ] Sentry events arriving with `lambda.region: "iad1"` AND `db.region: "us-east-1"` tags

## 10. Performance improvement estimates after region alignment

| Metric | Before (Tokyo) | After (us-east-1) | Δ |
|---|---|---|---|
| Single `SELECT 1` RTT | 748 ms | < 5 ms | -99% |
| Single `COUNT(*)` query | 748 ms | < 5 ms | -99% |
| Attendance check-in (warm, total) | ~340 ms (already batched well) | ~150 ms (TX still fastest path) | -56% |
| Approval PATCH (warm, total) | ~600 ms typical | ~200 ms typical | -67% |
| Telegram enqueue (single insert) | ~750 ms | < 50 ms | -93% (now meets < 150 ms target) |
| Dashboard load (cold) | ~2.5 s typical | < 1 s typical | -60% |
| Cron drain (20 rows × 1 INSERT + 1 UPDATE) | ~30 s | < 2 s | -93% |
| `/api/debug/runtime-health` `elapsedMs` warm | ~11 s | < 1 s | -91% |

The end-user experience improvement is dominated by check-in / approval /
dashboard p95 reduction. The cron drain improvement is the most
operationally significant — Telegram queue can keep up with bursty
attendance events without backlog buildup.

---

## 11. References

- Supabase: [Migrate a project](https://supabase.com/docs/guides/platform/migrating-and-upgrading-projects)
- Prisma: [Connection management in serverless](https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections#serverless-environments)
- Vercel: [Function regions](https://vercel.com/docs/functions/configuring-functions/regions)
- Internal: `docs/MIGRATION.md` (Phase 1/2/3 of the Sheets→Postgres migration)
- Internal: `docs/SENTRY.md` (observability + alert routing)
