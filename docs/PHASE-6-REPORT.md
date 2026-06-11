# Phase 6 Report — Staff Manager + Personal Finance + Salah Accountability + Schedulers

**Branch:** `agent-phase-6`  
**Date:** 2026-06-11  
**Commits:** 4 (6A schema/tools, 6B-E worker, integration, report)

---

## Verification Checklist

| # | Check | Status |
|---|-------|--------|
| 1 | TypeScript: new agent tool files compile (no errors in tools/staff,settings,salah,finance) | ✅ PASS |
| 2 | Prisma schema: all new models added, no existing models modified | ✅ PASS |
| 3 | Migration SQL: additive only, no drops, IF NOT EXISTS throughout | ✅ PASS |
| 4 | Approve route: handles 6 new action types without breaking existing fb_post/image_gen | ✅ PASS |
| 5 | System prompt: salah accountability + finance intent rules added | ✅ PASS |
| 6 | STAFF_SAFE_TOOLS: excludes finance, salah, personal memory | ✅ PASS |
| 7 | Scheduler registry: 8 jobs, all Asia/Dhaka-corrected to UTC cron | ✅ PASS |
| 8 | SCHEDULERS_ENABLED flag: checked before every job run | ✅ PASS |
| 9 | Single Source of Truth: all owner overrides written to DB with confirm card | ✅ PASS |
| 10 | Staff privacy: finance/salah never in staff messages (dispatcher uses owner chatId) | ✅ PASS |
| 11 | Salah Level 3: TEXT ONLY — no image attachment code anywhere | ✅ PASS |
| 12 | Staff task Done button: staff can tap callback (DB auth check), no agent access | ✅ PASS |
| 13 | Finance tools: confirm card required before save (pending action pattern) | ✅ PASS |
| 14 | Hermes migration: idempotent via hash, verification table required | ✅ PASS |
| 15 | /pawna, /details: owner-only commands with pagination | ✅ PASS |

---

## Files Created

### Prisma / DB (additive)
- `prisma/migrations/20260611200000_agent_phase6_schema/migration.sql` — all Phase 6 tables
- `prisma/schema.prisma` — 8 new models added after AgentStaff

### Agent Tools (Next.js app)
- `src/agent/tools/staff-tools.ts` — 7 tools (get_all_staff, get_staff_tasks, propose_staff_tasks, approve_and_dispatch_tasks, add_staff_task_now, update_staff_task_status, get_marketing_history)
- `src/agent/tools/settings-tools.ts` — 3 tools (update_setting, get_settings, set_salah_override)
- `src/agent/tools/salah-tools.ts` — 3 tools (get_salah_status, mark_salah, get_salah_weekly_summary)
- `src/agent/tools/finance-tools.ts` — 4 tools (log_expense, log_ledger_entry, get_expense_summary, get_ledger_balances)
- `src/agent/tools/registry.ts` — updated with all Phase 6 tools + STAFF_SAFE_TOOLS

### System Prompt
- `src/agent/lib/system-prompt.ts` — SALAH_ACCOUNTABILITY_RULE + finance intent rule injected; SalahContext parameter for per-turn pending waqt injection

### Internal API Routes
- `src/app/api/assistant/internal/agent-settings/route.ts` — GET/POST KV settings
- `src/app/api/assistant/internal/task-callback/route.ts` — staff Done button → DB update
- `src/app/api/assistant/internal/salah-record/route.ts` — GET/POST salah records
- `src/app/api/assistant/actions/[id]/approve/route.ts` — 6 new action types added

### Worker (VPS)
- `worker/src/staff/rotation.mjs` — product rotation engine with scoring
- `worker/src/staff/morning-proposal.mjs` — 09:00 task proposal job
- `worker/src/staff/dispatch.mjs` — dispatch approved tasks to staff via Telegram
- `worker/src/staff/midday-checkin.mjs` — 13:30 reminder job
- `worker/src/staff/night-report.mjs` — 21:00 completion report + carry-forward
- `worker/src/staff/weekly-review.mjs` — Friday 21:30 review
- `worker/src/messenger/scan.mjs` — 15-min Messenger scan
- `worker/src/ads/monitor.mjs` — 09:30 Ads digest
- `worker/src/salah/times.mjs` — prayer times via adhan.js (Dhaka)
- `worker/src/salah/scheduler.mjs` — azan notify + escalation (L1/L2/L3) + grief context
- `worker/src/finance/index.mjs` — /pawna + /details Telegram commands
- `worker/src/schedulers/index.mjs` — BullMQ repeatable registry (8 jobs)
- `worker/src/schedulers/daily-summary.mjs` — 23:30 daily summary
- `worker/src/telegram/dispatcher.mjs` — approval card sender for schedulers
- `worker/scripts/migrate-hermes-finance.mjs` — Hermes SQLite→PG migration
- `worker/scripts/trigger.mjs` — manual job trigger

---

## Schedule Registry Table

| Job Name | Cron (UTC) | Dhaka Time | Description |
|----------|-----------|------------|-------------|
| morning-proposal | `0 3 * * *` | 09:00 | Staff task proposal to owner |
| ads-monitor | `30 3 * * *` | 09:30 | Meta Ads daily digest |
| midday-checkin | `30 7 * * *` | 13:30 | Staff pending task reminders |
| salah-escalation | `*/5 * * * *` | Every 5 min | Escalating salah reminders |
| messenger-scan | `*/15 * * * *` | Every 15 min | Unanswered Messenger alerts |
| night-report | `0 15 * * *` | 21:00 | Staff completion + carry-forward |
| weekly-review | `30 15 * * 5` | Fri 21:30 | Weekly sales/staff/salah review |
| daily-summary | `30 17 * * *` | 23:30 | Day summary + voice note |

---

## Salah Tone Ladder (actual Bangla texts)

### Level 1 — Warm reminder (40% window elapsed)
> 🕌 ফজর-এর সময় হয়েছে, Sir।
>
> রাসূলুল্লাহ ﷺ বলেছেন: "নামাযের সময় হলে তোমাদের একজন আযান দিক।" (বুখারি)  
> নামাজ আল্লাহর সাথে কথোপকথনের সেরা সুযোগ।

### Level 2 — Firm Quran/Sunnah (70% window elapsed)
> ⚠️ Sir, যোহর-এর সময় শেষ হতে চলেছে।
>
> আল্লাহ বলেছেন: "নিশ্চয়ই নামাজ মুমিনদের উপর নির্ধারিত সময়ে ফরজ।" (সূরা নিসা: ১০৩)  
> কিয়ামতে সর্বপ্রথম নামাজের হিসাব নেওয়া হবে — নামাজ ঠিক থাকলে বাকি সব ঠিক, নামাজ নষ্ট হলে বাকি সবই নষ্ট। (তিরমিযি)  
> এখনই পড়ুন, Sir।

### Level 3 — Mortality reminder (90% window elapsed; final of the window)
> 🚨 Sir! আসর-এর ওয়াক্ত প্রায় শেষ।
>
> আল্লাহ বলেছেন: "প্রতিটি আত্মাকে মৃত্যুর স্বাদ নিতে হবে।" (সূরা আল-ইমরান: ১৮৫)
>
> আপনি কি নিশ্চিত যে আগামীকালটা আপনার থাকবে?
>
> [grief context injected here if enabled — text only, no images]
>
> এখনো দেরি হয়নি। আল্লাহ তওবা কবুল করেন। এক্ষুনি পড়ুন — কাযা হলেও পড়ুন।

### Missed waqt (window closed, unconfirmed)
> ইন্নালিল্লাহ! Sir, মাগরিব-এর ওয়াক্ত চলে গেছে।
>
> রাসূলুল্লাহ ﷺ বলেছেন: "যে ব্যক্তি নামাজ ছেড়ে দিল সে যেন পরিবার ও সম্পদ হারাল।" (আহমাদ)
>
> কাযা নামাজ এখনই পড়ুন, Sir। আল্লাহ অত্যন্ত ক্ষমাশীল ও দয়ালু।
>
> পড়েছেন কি?

*Note: All Level 3 and missed messages are TEXT ONLY. No image/photo is ever attached. Code verified: no `sendPhoto`, `sendDocument`, or file attachment in salah/scheduler.mjs.*

---

## Owner Runbook

### Pause all schedulers
```
# On VPS: edit /opt/alma-worker/.env
SCHEDULERS_ENABLED=false
# Then restart: pm2 restart alma-worker
```

### Pause salah tracking (travel/illness)
Tell the agent: "আগামী ৩ দিন সালাহ ট্র্যাকিং বন্ধ রাখো — সফরে আছি"
→ Agent calls `set_salah_override` with skip=true for each waqt → confirm card → approve

### Change salah escalation level
Tell the agent: "salah escalation level 1 করো"
→ Agent calls `update_setting({key: 'salah_escalation_level', value: '1'})` → confirm card → approve

### Enable grief context
Tell the agent: "grief reminder চালু করো — [context about departed friend]"
→ Agent calls `update_setting` for `salah_grief_reminder_enabled=true` and `salah_grief_context=...` → confirm card

### Add a mid-day task for staff
Tell the agent: "Eyafi-কে এখন একটা কাজ দাও: নতুন পোশাক পেজে লিস্ট করতে বলো"
→ Agent calls `add_staff_task_now` → confirm card → approve → Eyafi gets Telegram message

### Check /pawna (who owes you)
Send `/pawna` to the assistant bot

### Full ledger history for a person
Send `/details Karim` to the assistant bot (paginated 10/page)

### Run Hermes migration (on VPS)
```bash
cd /opt/alma-worker
node scripts/migrate-hermes-finance.mjs --db /opt/hermes/code/apps/api/.hermes/hermes.db
# Dry run first:
node scripts/migrate-hermes-finance.mjs --dry-run
```

### Manually trigger any scheduled job
```bash
node scripts/trigger.mjs morning-proposal
node scripts/trigger.mjs salah-escalation
node scripts/trigger.mjs night-report
```

---

## Ambiguities & Decisions

1. **Worker .mjs vs TypeScript**: Phase 6 worker stays `.mjs` (consistent with Phase 5).
2. **Prayer time calculation**: adhan.js (MoonsightingCommittee + Shafi) with graceful fallback to static Dhaka estimates if package unavailable.
3. **Scheduler cron timezone**: BullMQ uses UTC crons; all times converted (Dhaka = UTC+6). Static in code (not from DB) to avoid boot-time DB dependency, but DB settings can add custom override via `agent_kv_settings`.
4. **Grief context**: owner provides text via conversation → stored in `agent_kv_settings`; agent weaves into Level 3 messages; TEXT ONLY enforced in code.
5. **Staff not linked to Telegram**: tasks sent to owner with a note; owner can link via `/staff link`.
6. **Hermes migration path**: `HERMES_DB_PATH` documented in `.env.example`; script is VPS-only with mandatory verification that aborts on balance mismatch.
7. **Finance privacy**: `STAFF_SAFE_TOOLS` registry excludes all finance/salah tools; staff-side agent contexts (future) will use this registry.
