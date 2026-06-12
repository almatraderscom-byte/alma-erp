# FINAL POLISH & PRODUCTION SIGN-OFF

**Date:** 2026-06-12 · **Branch:** `claude/final-polish-signoff-ue822j` · **Scope:** verification + minimal fixes only, no new features.

## How this was verified (read first)

This sign-off session ran in an isolated CI container with **no access to the production Telegram bot, the VPS (pm2/Redis), Vercel logs, Sentry, or the production database**. Therefore:

- Every test-matrix item was verified by **full end-to-end code-path tracing** (tool → API route → DB model → worker job → Telegram/ntfy delivery → callback → DB update), plus build, typecheck, and the project's standalone unit scripts.
- Anything that genuinely requires the live system is marked **OWNER-LIVE** below with the exact command/message to run. Phases 0–10 were each live-tested by the owner at merge time per the phase reports, so OWNER-LIVE items are re-confirmation, not first-time tests.
- Three real defects were found and **fixed in this session** (marked FIXED). Everything else passed as-is.

**Verification baseline:** `npm run type-check` ✅ PASS · `npm run build` ✅ PASS · `node --check` on changed worker file ✅ PASS · `git diff --stat` scope check ✅ (only files listed under "Fixes applied").

---

## STEP 1 — Test matrix results

| # | Test | Code verification | Result | Live re-check |
|---|---|---|---|---|
| 1a | Reminder 2 min ahead → ticker fires → text+voice+ntfy | `set_reminder` → `agent_reminders` → ticker (every 1 min, `worker/src/reminders/ticker.mjs`) → `notify()` tier delivery (Telegram + TTS voice + ntfy) — chain complete, no stubs | **PASS** | OWNER-LIVE: "২ মিনিট পরে টেস্ট রিমাইন্ডার দাও" |
| 1b | [✅ Done] updates DB | `reminder_done:<id>` callback → `POST /api/assistant/internal/reminder-update` → status `done` | **PASS** | tap button |
| 1c | Recurring → next occurrence created | `recurrenceRrule` → `computeNextDueAt()` (`src/agent/lib/reminder-rrule.ts`) resets reminder to `pending` with next `dueAt` on Done — verified in `reminder-update/route.ts:66-83` | **PASS** | "প্রতিদিন সকাল ৮টায়..." then Done |
| 2a | Urgent test alert → tier-2 critical ntfy | `send_urgent_alert` tier 2 → immediate dispatch → `urgent-alert` route → worker `processUrgentNotify` → ntfy CRITICAL topic | **PASS** | OWNER-LIVE: "এখনই একটা urgent test alert দাও" |
| 2b | Tier-3 rate-limit rejects 3rd call (unit-level) | `scripts/test-reminder-rate-limit.mjs` → **all 4 checks PASS** (tier 2 = 5/hour, tier 3 = 2/day, counted via `agentNotification.count`); guard enforced in both the tool handler and the API route (429) | **PASS** (unit test run this session) | — |
| 3 | Shared brain: web fact → Telegram recall in new conversation | `save_memory` (pgvector, `agent_memory`) is surface-agnostic; Telegram daily conversations call the same `runAgentTurn()` which injects pinned + top-3 relevant memories every turn (`core.ts:165-206`, `system-prompt.ts:149-211`) | **PASS** | OWNER-LIVE: tell web a fact, ask on Telegram after `/new` |
| 4 | ask_user buttons on web AND Telegram; tap flows as answer | Web: `ask_card` SSE event → `AgentAskCard.tsx` → answer route. Telegram: `ask_pick:` callback → answer route → `handleOwnerText(ctx, option)` feeds the option back as the user's message | **PASS** | tap an option on both surfaces |
| 5a | salah-init + escalation → records, reminder, mark via button | init at 00:00 Dhaka creates 5 records; escalation every 5 min sends azan/40%/70%/90% ladder; `salah_done:` button + auto-mark from chat text both upsert the record | **PASS** | observe next waqt |
| 5b | Override "আজ Dhuhr ২:৩০ এ পড়বো" honored by **next escalation run** | **FAIL → FIXED.** Approved overrides were written to `salah_overrides` but the escalation loop never read that table — overrides only took effect at the next midnight init. Fixed: `checkAndEscalateSalah()` now reads the override on every run and uses the overridden start time (and honors `skip`). `worker/src/salah/scheduler.mjs` | **FIXED** | OWNER-LIVE after deploy: set an override mid-window |
| 6 | Staff: morning-proposal → approve → dispatch → Done → night-report (completion + reply-time line + carry-forward) | 09:00 proposal job → approval card → `dispatch_staff_tasks` → per-staff Telegram with `task_done:` buttons → night report 21:00 aggregates done %, appends Messenger reply-time stats (`reply-stats.mjs`), marks unfinished as `carried` for next morning | **PASS** | OWNER-LIVE on a working day with linked staff |
| 7a | Single expense | `log_expense` → confirm card → approve → `agent_finance_expenses` | **PASS** | "৫০০ টাকা খরচ" |
| 7b | BATCH 5 mixed-currency lines → batch tool, single confirm | `log_expenses_batch` / `log_ledger_entries_batch` (2–30 entries, one confirm card, per-currency totals); system prompt forbids repeated single calls | **PASS** | one message, 5 lines |
| 7c | Missing-currency line triggers a question | **GAP → FIXED.** Tools silently defaulted to BDT; nothing instructed the agent to clarify. Fixed: system-prompt finance rule now requires `ask_user` (BDT না AED?) before the tool call when a line's currency is not determinable. `src/agent/lib/system-prompt.ts` | **FIXED** | line without tk/AED marker |
| 7d | /pawna and /details correct | Net per-person per-currency balances with correct direction signs; `/details` paginated ledger history — `worker/src/finance/index.mjs` | **PASS** | `/pawna`, `/details <নাম>` |
| 8 | GPS: live location → rows → map link → stop → owner notified | `handleStaffLocation` (2-min throttle) → `staff_locations` → `get_staff_location` returns Google Maps link → stop event inserts `stopped` row + owner notify | **PASS** | OWNER-LIVE with a staff phone |
| 9 | Image gen + FB read regression | `generate_image` → confirm → worker → Gemini → Supabase `agent-files` → job-result message; `get_fb_recent_posts` via Graph v21.0 with retry — both chains intact, untouched since Phase 7/8 | **PASS** | "একটা টেস্ট ছবি বানাও" |
| 10a | /agent/costs loads with real data | Route + `getCostDashboardData()` aggregations verified; production build compiles the page. DB smoke script (`scripts/test-cost-dashboard.mjs`) needs live `DATABASE_URL` — not runnable here | **PASS (code)** | OWNER-LIVE: open the page |
| 10b | CSV export downloads | `GET /api/assistant/costs/export?month=` with UTF-8 BOM + filename | **PASS** | click Export |
| 10c | Budget alert at test threshold | Hourly `budget-check` job → 80% Tier 1 / 100% Tier 2, deduped once per period via KV keys | **PASS** | set a tiny daily budget, wait ≤1h |

---

## STEP 2 — Health sweep results

| Check | Result |
|---|---|
| Typecheck (`tsc --noEmit`) | ✅ PASS, zero errors |
| Production build (`prisma generate && next build`) | ✅ PASS |
| Unit scripts (rate-limit, salah-intent, staff-safe-tools) | ✅ all PASS this session |
| pm2 24h log scan | ⚠️ OWNER-LIVE — run on VPS: `pm2 logs agent-worker --lines 1000 --nostream \| grep -iE "error\|fail"` |
| Sentry unresolved issues | ⚠️ OWNER-LIVE — check Sentry dashboard, `category:agent` tag |
| Watchdog: kill worker → alert ≤10 min | **FAIL → FIXED.** Watchdog cron was `*/10` with a 5-min stale threshold → worst case ~15 min. Changed to `*/5` in `vercel.json` → worst case now exactly 10 min. Kill-test itself is OWNER-LIVE: `pm2 stop agent-worker`, wait, confirm critical ntfy, then `pm2 start agent-worker` | **FIXED** |
| pm2 startup persists after reboot | ⚠️ OWNER-LIVE — `systemctl is-enabled pm2-root` should print `enabled`; documented in OPERATIONS.md runbook |
| Vercel 4xx/5xx on /api/assistant/* | ⚠️ OWNER-LIVE — Vercel → Logs → filter `/api/assistant/` during the live test window (429s from intentional rate-limit tests are expected) |
| **Secrets sweep (repo grep, all tracked files incl. docs/)** | **FAIL → FIXED.** Two findings: (1) `.env.telegram` was tracked in git containing the real `TRADING_SCREENSHOT_CLEANUP_SECRET` value and an (expired) Vercel OIDC token; (2) a stale 578 MB `.next.stale.*` build directory (688 files) was committed. Both untracked and added to `.gitignore`. After the fix, the full token/key/password grep across all tracked files (including docs/ and phase reports) returns **zero** hits. ⚠️ **Action for owner:** the leaked values remain in old git history — rotate `TRADING_SCREENSHOT_CLEANUP_SECRET` in Vercel (one env-var change; the code reads it from env). The OIDC token expired in May 2026 — no action needed. |

## Fixes applied this session (complete diff scope)

| File | Change | Matrix item |
|---|---|---|
| `worker/src/salah/scheduler.mjs` | Escalation loop now reads `salah_overrides` every run (honors override time, delay, skip same-day) | 5b |
| `src/agent/lib/system-prompt.ts` | Finance rule: ambiguous currency → `ask_user` before tool call, never guess | 7c |
| `vercel.json` | Watchdog cron `*/10` → `*/5` (dead-worker alert ≤10 min) | Health sweep |
| `.gitignore` + untracked `.env.telegram`, `.next.stale.1779127369/` | Secrets/artifact hygiene | Secrets sweep |
| `docs/OPERATIONS.md` | New — owner-facing operations manual (Bangla) | Step 3 |
| `docs/FINAL-SIGNOFF.md` | This report | Step 4 |

---

## STEP 4 — Original-requirements traceability

Source: phase prompt deliverables as recorded in `docs/PHASE-0..10-REPORT.md`, re-verified against the current codebase this session. "Live" = verified on production/preview during that phase's owner sign-off per its report; **all implementation locations re-confirmed present in code this session.**

| Requirement (original) | Where implemented | Live-verified |
|---|---|---|
| **P0** Agent module skeleton, kill-switch guard on every route | `src/agent/config.ts`, `lib/guards.ts` (`requireAgentEnabled`), all `/api/assistant/*` routes | yes (P0) |
| **P0** Agent DB models (projects/conversations/messages/artifacts/memory/tool_calls), additive migration | `prisma/schema.prisma` + `20260610120000_agent_module_phase0` | yes (P0) |
| **P0** `/agent` owner-only page + `/api/assistant/health` | `src/app/agent/page.tsx`, `health/route.ts` | yes (P0) |
| **P1** Claude streaming core loop (claude-sonnet-4-6, adaptive thinking, prompt caching, full history) | `src/agent/lib/core.ts` (`runAgentTurn`), `system-prompt.ts` | yes (P1) |
| **P1** Chat + conversation CRUD routes, token/cost tracking per turn | `/api/assistant/chat`, `/api/assistant/conversations*`, cost calc in `core.ts` | yes (P1) |
| **P2** Claude.ai-style web UI (sidebar/thread/artifacts/markdown/upload/projects) | `src/agent/components/*`, `/api/assistant/upload`, `projects*` | yes (P2) |
| **P3** pgvector memory + save/search/update/delete tools + auto-RAG (pinned 30 + top-3 ≥0.45) | `agent_memory` + HNSW migration, `registry.ts:80-183`, `core.ts:165-206`, `embeddings.ts` | yes (P3) |
| **P3** Whisper transcription (bn) + Google TTS bn-IN-Chirp3-HD-Charon | `/api/assistant/transcribe`, `/api/assistant/tts` | yes (P3) |
| **P4** 7 ERP read tools (sales/orders/inventory/product/customer/employee/dashboard) | `src/agent/tools/erp-tools.ts` | yes (P4) |
| **P4** Pending-action confirm cards (30-min expiry, approve/reject) | `agent_pending_actions`, `/api/assistant/actions/[id]/*`, `AgentConfirmCard.tsx` | yes (P4) |
| **P4** VPS worker + Redis/BullMQ job queue (long tasks never on Vercel) | `worker/src/index.mjs`, `ecosystem.config.cjs` | yes (P4) |
| **P4** Image generation (Gemini direct API, pro/standard, reference image) → Supabase → conversation | `confirm-tools.ts` (`generate_image`), `worker/src/index.mjs:117-199` | yes (P4) + regression code-pass this session |
| **P4** Facebook direct Graph API: post with confirm + self-verify, read recent posts | `lib/meta.ts`, `confirm-tools.ts` (`post_to_facebook`, `get_fb_recent_posts`) | yes (P4) + regression code-pass |
| **P5** Telegram bot (owner-only, daily conversations, confirm buttons, voice in/out, message splitting, typing) | `worker/src/telegram/*`, `internal/telegram-conversation` | yes (P5) |
| **P5** ntfy tier 1/2 + Twilio tier-3 call (8kHz WAV) + notification logging | `worker/src/notify/*`, `agent_notifications` | yes (P5) |
| **P6** Staff task system: proposal → approve → dispatch → Done button; staff privacy (no finance/salah/memory to staff; STAFF_SAFE_TOOLS) | `worker/src/staff/*`, `staff-tools.ts`, registry STAFF_SAFE_TOOLS (unit test PASS this session) | yes (P6) |
| **P6** Salah accountability: daily init, 4-level Bangla escalation ladder, buttons, overrides, grief context | `worker/src/salah/*`, `settings-tools.ts`, `salah_records`/`salah_overrides` | yes (P6) + **override gap fixed this session** |
| **P6** Personal finance: expense/ledger tools with confirm, Hermes data migration, `/pawna` `/details` | `finance-tools.ts`, `worker/src/finance/index.mjs`, `migrate-hermes-finance.mjs` | yes (P6) |
| **P6** Scheduler suite with `SCHEDULERS_ENABLED` flag | `worker/src/schedulers/index.mjs` (13 jobs) | yes (P6) |
| **P7** Sentry (app+worker), heartbeat + watchdog + health-ping, pm2 hardening, nightly backup, idempotency (FB post, job result, dispatch), rate limits, log hygiene | `lib/sentry.ts`, `internal/heartbeat|watchdog|health`, `worker/src/health-ping.mjs`, `scripts/agent-backup.sh`, `log-safe.mjs` | yes (P7) + **watchdog cadence tightened this session** |
| **P8** Cost dashboard: `logCost()` everywhere, pricing table, subscriptions, budgets (80/100% alerts), `/agent/costs` UI, CSV export, daily cost line | `lib/cost-*.ts`, `pricing.ts`, `/api/assistant/costs/*`, `worker` budget-check/cost-reconcile/subscription-renewal jobs | yes (P8) |
| **P9** Reminders (RRULE recurrence, 3 tiers, escalation +10/+25 min, max 3 sends, Done/Snooze/Cancel buttons) | `reminder-tools.ts`, `reminder-rrule.ts`, `worker/src/reminders/*`, `internal/reminders-due|reminder-update` | yes (P9) |
| **P9** Urgent alerts (tier-2 immediate ≤5/hr, tier-3 confirm-card ≤2/day) | `reminder-tools.ts:194`, `urgent-rate-limit.ts`, `internal/urgent-alert` | yes (P9) + unit test PASS this session |
| **P9** Shared brain: aggressive auto-save prompt + cross-surface context injection | `system-prompt.ts` memory rules, `cross-surface.ts` | yes (P9) |
| **P10** `ask_user` clarify buttons web + Telegram | `ask-tools.ts`, `AgentAskCard.tsx`, `ask-cards/[id]/answer`, `ask_pick:` handler | yes (P10) |
| **P10** Staff reply-time stats in night report | `worker/src/messenger/reply-stats.mjs`, `staff_reply_stats`, `night-report.mjs` | yes (P10) |
| **P10** Staff GPS (live location, task-done location, history tools, stop-share owner notify) | `worker/src/telegram/location.mjs`, `staff_locations`, `location-tools.ts` | yes (P10) |
| **P10** Quick commands `/today` `/khoroch` `/ask` | `worker/src/telegram/quick-commands.mjs` | yes (P10) |
| **P10** Meta Ads write v1 (`pause_campaign`, `update_campaign_budget`) with `ads_management` scope check + confirm | `ads-tools.ts`, `meta-ads.ts` | yes (P10) |
| **Final** Operations manual (Bangla, owner-facing) | `docs/OPERATIONS.md` | this session |
| Deferred by owner (unchanged, intentional): full campaign creation, Twilio/ElevenLabs voice alternatives, Hermes decommission execution | — checklist provided in OPERATIONS.md §6, **not executed** | n/a |

---

## Sign-off statement

All 10 phases' requirements are implemented and traceable. Three defects found in this final sweep (salah mid-day override ignored, no currency-clarification rule, watchdog worst-case 15 min) and two repo-hygiene failures (tracked secret file, committed build artifact) are **fixed in this branch**. Build, typecheck, and all runnable unit checks are green. Remaining items are live re-confirmations on the owner's devices/VPS, listed inline above, plus one recommended action: **rotate `TRADING_SCREENSHOT_CLEANUP_SECRET` in Vercel** (value exists in old git history).
