# Phase 9 Report — Reminders, Urgent Alerts, Shared Brain

**Branch:** `agent-phase-9`  
**Tag (pre-flight):** `pre-agent-phase-9`  
**Date:** 2026-06-12  
**Commit:** `feat(agent): Phase 9 — reminders, urgent alerts, shared-brain auto-save`

---

## Verification Checklist

| # | Check | Status |
|---|-------|--------|
| 1 | Migration `agent_reminders` additive, plain indexes (no `::` in indexes) | ✅ PASS |
| 2 | Agent tools: set/list/cancel/snooze reminder + send_urgent_alert | ✅ PASS |
| 3 | Worker `reminder-ticker` every minute + Telegram Done/Snooze/Cancel | ✅ PASS |
| 4 | Tier 2 urgent: 5/hour; Tier 3: 2/day rate limits | ✅ PASS (code + `test-reminder-rate-limit.mjs`) |
| 5 | Shared brain: aggressive save_memory prompt + cross-surface snippets | ✅ PASS |
| 6 | `npm run type-check` + `npm run build` | ✅ PASS |
| 7 | `node scripts/test-staff-safe-tools.mjs` | ✅ PASS |

---

## Part 1 — Reminder System

### Schema

`agent_reminders`: title, body, due_at, recurrence_rrule, tier (1–3), voice, status, snoozed_until, last_sent_at, send_count, source_conversation_id.

Indexes: `(status, due_at)`, `(due_at)`.

### Agent tools

| Tool | Behaviour |
|------|-----------|
| `set_reminder` | tier 1–2 save directly + Bangla confirmation; tier 3 → confirm card |
| `list_reminders` | Filter by status |
| `cancel_reminder` | status → cancelled |
| `snooze_reminder` | +N minutes |
| `send_urgent_alert` | tier 2 immediate via internal route; tier 3 confirm card |

### Internal routes

- `GET /api/assistant/internal/reminders-due` — due + escalation candidates
- `POST /api/assistant/internal/reminder-update` — worker/Telegram status
- `POST /api/assistant/internal/urgent-alert` — queue immediate notify (rate-limited)

### Worker

- Scheduler `reminder-ticker` (`* * * * *` UTC)
- `notify()` + Telegram with **[✅ Done] [⏰ +৩০ মিনিট] [🗑️ বাতিল]**
- Escalation: +10 min resend; +25 min tier+1 (max 3 sends)
- Recurring: on done → next RRULE occurrence (DAILY/WEEKLY/MONTHLY)

---

## Part 2 — Shared Brain

### System prompt additions (owner review)

**স্মৃতি (আগ্রাসী):**
- স্থায়ী তথ্য/পছন্দ/সিদ্ধান্ত/পরিকল্পনা/ব্যক্তি → টার্ন শেষের আগে `save_memory` বাধ্যতামূলক
- উদাহরণ: দুবাই যাত্রা, supplier নাম, report সময়
- `search_memory` — অন্য সারফেসের তথ্য খুঁজতে

**রিমাইন্ডার:**
- মনে করিয়ে দিতে বললে → `set_reminder` (টুল ছাড়া claim নিষিদ্ধ)
- জরুরি → tier 2; ফোন → tier 3

### Cross-surface continuity

`core.ts` injects 5 recent **other** conversations (title + last assistant line) into system prompt each turn.

### Manual verification

1. Web: "মনে রাখো, আমার নতুন supplier-এর নাম Rahim Traders"
2. Telegram: "আমার নতুন supplier-এর নাম কী?" → should answer from memory

---

## Part 3 — Live test plan (VPS)

```bash
# After merge + migrate deploy:
node worker/scripts/trigger.mjs reminder-ticker

# 2-minute test reminder via agent:
# "২ মিনিট পরে test reminder দাও"
```

Expected: Telegram text + voice + ntfy; Done button → status `done`.

---

## Files changed (agent/worker scope)

- `prisma/migrations/20260612120000_agent_phase9_reminders/`
- `prisma/schema.prisma` — `AgentReminder`
- `src/agent/tools/reminder-tools.ts`
- `src/agent/lib/reminder-rrule.ts`, `urgent-rate-limit.ts`, `cross-surface.ts`
- `src/agent/lib/core.ts`, `system-prompt.ts`
- `src/app/api/assistant/internal/reminders-due|reminder-update|urgent-alert/`
- `worker/src/reminders/ticker.mjs`, `callbacks.mjs`
- `worker/src/schedulers/index.mjs`
- `scripts/test-reminder-rate-limit.mjs`

---

## Ambiguities / decisions

1. **RRULE:** Minimal parser (DAILY/WEEKLY/MONTHLY) — no full RFC5545 library to keep deps light.
2. **Urgent tier 2:** Queued as `urgent_notify` pending action (status `approved`) — worker poll dispatches within ~30s.
3. **Escalation anchor:** Elapsed time from original `due_at` (not `last_sent_at`) for 10/25 min ladder.
