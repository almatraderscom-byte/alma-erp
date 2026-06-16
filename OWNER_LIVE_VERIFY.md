# OWNER_LIVE_VERIFY — eyes-only post-deploy checklist

These are the things only the owner can confirm with real credentials and live runtime. Run them after every Vercel + worker deploy.

Each item is **exact command or click + expected result**. Do not assume "should work" — execute and verify.

---

## 1. Vercel app live + healthy

**Command (any browser or terminal):**
```bash
curl -s https://alma-erp-six.vercel.app/api/health | jq '{ok, env:.env.ok, db:.database.ok, commit:.frontend.git_commit}'
```

**Expected:**
```json
{ "ok": true, "env": true, "db": true, "commit": "<latest_main_sha>" }
```

If `ok:false` or `commit` is stale → **deployment did not roll out**. Open Vercel dashboard, find latest deployment, click "Promote to production".

---

## 2. Worker process online + heartbeats fresh

**Command (from your machine):**
```bash
ssh root@31.97.237.40 'pm2 jlist | python3 -c "import sys, json; d=[x for x in json.load(sys.stdin) if x[\"name\"]==\"agent-worker\"][0]; print(d[\"pm2_env\"][\"status\"], d[\"pm2_env\"][\"restart_time\"])"'
```

**Expected:**
- First word: `online`
- Restart time: matches recent deploy timestamp (or older if no worker change)

**Then:**
```bash
ssh root@31.97.237.40 "set -a; source /opt/alma-erp/worker/.env; set +a; \
  psql \"\$DATABASE_URL\" -tAc \"SELECT service, last_beat_at, EXTRACT(EPOCH FROM (NOW() - last_beat_at)) AS seconds_ago FROM agent_heartbeats ORDER BY service\""
```

**Expected:** 4 rows (`app-health`, `queue-consumer`, `schedulers`, `telegram-bot`). All `seconds_ago` values < 120.

If any service hasn't beaten in > 5 min, you should also have received an owner-Telegram alert from the watchdog cron.

---

## 3. Twilio salah call still works (P0 fix verification)

**Trigger:** wait for next salah call (Fajr/Zuhr/Asr/Maghrib/Isha) OR test by manually triggering from VPS:
```bash
ssh root@31.97.237.40 'cd /opt/alma-erp/worker && pm2 logs agent-worker --lines 0 --nostream &
sleep 1; node -e "import(\"./src/notify/twilio-call.mjs\").then(m => m.sendSalahReminderCall(\"Test\", \"+880XXXXXXXXX\"))"'
```
*(Replace phone with your number. Pass-through for sanity only.)*

**Expected:**
- Phone rings within ~10s
- Bangla TwiML plays (audio + Say fallback)
- Twilio status callback hits `/api/twilio/call-status` and **returns 200** (not 403)
- `agent_pending_actions` table gets a "missed call retry" row only if you don't pick up within 12s

If the status callback returns 403 → Twilio HMAC verification is failing. Check `TWILIO_AUTH_TOKEN` is set on Vercel (not just on VPS).

---

## 4. Messenger CS pipeline still sends real replies

**Test:** From a customer-side Messenger account, send a real product question to one of the FB pages (Alma Lifestyle / Alma Online Shop).

**Expected within 8–25 seconds:**
- "Typing…" indicator appears
- Bangla CS reply arrives, with image if relevant
- In owner Telegram, no shadow-draft notification (means full-auto worked) OR a shadow-draft card if the customer is new/unhandled

**Verify on backend:**
```bash
ssh root@31.97.237.40 "set -a; source /opt/alma-erp/worker/.env; set +a; \
  psql \"\$DATABASE_URL\" -c \"SELECT id, role, meta_message_id, created_at FROM cs_messages ORDER BY created_at DESC LIMIT 5\""
```

**Expected:**
- 2+ rows for the test conversation (customer message + agent reply)
- `meta_message_id` on customer rows is populated and **unique** (the new partial unique index will reject any duplicate insert)

If you see no agent reply OR a duplicate customer message → check Sentry for errors and worker logs (`pm2 logs agent-worker --lines 100`).

---

## 5. Owner Telegram bot responsive

**Action:** Send `/start` to your assistant Telegram bot.

**Expected:** Bangla welcome message + main menu (CC Camera Room, Todo, etc.) within 2 seconds.

**Then send a real query** like "ajker order shongkha kemon?" and confirm:
- Bot replies in 5–60s
- Reply is in Bangla
- Reply is fact-grounded (real order count, not hallucination)

If bot doesn't reply: `pm2 logs agent-worker --lines 50` and look for "telegram" errors.

---

## 6. Daily focus plan + weekly business intel (newly fixed AI routes)

These routes were using a deprecated Claude model and would have failed. Now use the locked `claude-sonnet-4-6`.

**Wait for:** next morning 08:00 (focus plan) and Monday 21:00 (weekly business intel).

**Expected:** receive a Bangla Telegram message from the bot with structured plan/report content (not "AI service unavailable" fallback text).

**Manual trigger if you want to test now:**
```bash
ssh root@31.97.237.40 "cd /opt/alma-erp/worker && \
  curl -s -X POST https://alma-erp-six.vercel.app/api/assistant/internal/generate-focus-plan \
  -H 'Authorization: Bearer \$(grep AGENT_INTERNAL_TOKEN .env | cut -d= -f2)' \
  -H 'Content-Type: application/json' \
  -d '{\"context\":\"3 pending orders, 2 staff late, BDT 12000 cashflow today\"}' | jq"
```

**Expected:** `{ "plan": "<Bangla text>" }` not `{ "plan": null, "error": "..." }`.

---

## 7. Mobile UI overlap fixes (owner-reported)

On your iPhone, open the agent app:

| Page | Expected |
|---|---|
| `/agent` (chat) | Header has 🔄 refresh button. Model selector sits ABOVE the chat input (not in header). Bottom nav doesn't cover the input. |
| `/agent/staff-monitor` (CC Camera Room) | Bottom of page has clearance — last card is fully visible above the bottom nav |
| `/agent/costs` | Same — last subscription card fully visible |
| `/trading/*` (sticky bottom action bar) | Sticky bar (Buy/Sell/Account/Screenshot) sits ABOVE the mobile nav, both visible |

If any page still has bottom overlap → hard-refresh (pull down to reload, or close + reopen app to clear PWA cache).

---

## 8. Production build + commit live

**On Vercel dashboard:** confirm latest deployment is "Production" status, not "Preview".

**On GitHub:** confirm `production-deploy-gate.yml` workflow run **passed** (green check on the merge commit).

If the gate failed (typecheck/lint/build/smoke), Vercel still deploys but the gate flagged a regression — investigate before next deploy.

---

## 9. Migration applied + index live

**Command:**
```bash
ssh root@31.97.237.40 "set -a; source /opt/alma-erp/worker/.env; set +a; \
  psql \"\$DATABASE_URL\" -c \"\\\\d cs_messages\" 2>&1 | grep meta_message"
```

**Expected:** A line like:
```
"cs_messages_meta_message_id_key" UNIQUE, btree (meta_message_id) WHERE meta_message_id IS NOT NULL
```

This is the new partial unique index that prevents Meta webhook double-insert race.

---

## 10. Sentry capturing errors

**Action:** intentionally hit a 404 on the app and check Sentry dashboard.

**Expected:** within 1 minute, the 404/error event appears in Sentry's issue stream with full stack and `requestId` tag (when available).

If no events arrive — confirm `SENTRY_DSN` is set on Vercel.

---

## After all 10 verifications pass

You can confidently announce production-ready. If any single one fails — **rollback** per `docs/DEPLOY_RUNBOOK.md` and triage before re-attempting.
