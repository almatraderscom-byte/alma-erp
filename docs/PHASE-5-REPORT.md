# Phase 5 Report — Telegram Bridge, Voice Notes, ntfy Escalation, Twilio Tier-3

**Date:** 2026-06-11  
**Branch:** `agent-phase-5`  
**Prerequisite:** Phase 4 (ERP tools, confirm cards, VPS worker) merged into `main`

---

## What Was Built

### Part 1 — Pre-flight
- Branch `agent-phase-5` created; tag `pre-agent-phase-5` set.
- Phase 4 report verified: worker scaffold, BullMQ queues, internal-token routes all present.
- `.env.example` updated with all Phase 5 variables:
  - `ASSISTANT_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`
  - `NTFY_SERVER`, `NTFY_TOPIC_GENERAL`, `NTFY_TOPIC_CRITICAL`
  - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_TO_NUMBER`

### Part 2 — Telegram Bot

**Location:** `worker/src/telegram/index.mjs`

- Telegraf 4.x long-polling (no webhook; runs on VPS permanently via pm2).
- **Owner guard:** Only `TELEGRAM_OWNER_CHAT_ID` gets agent access; unknown chat IDs receive "অনুমতি নেই" + their chat ID (logged for Phase 6 staff collection).
- **Chat bridge:** owner text → `POST /api/assistant/chat?stream=false` (internal token) → final text reply sent to Telegram.
- **Daily conversations:** `GET /api/assistant/internal/telegram-conversation?date=YYYY-MM-DD` finds/returns today's conversation. If none exists, the chat endpoint creates it automatically on first message (title: "Telegram YYYY-MM-DD").
- **Commands:** `/new` (reset daily conversation), `/chats` (inline keyboard with 5 recent chats), `/help` (Bangla), `/staff link <name> <chatId>` (Phase 6 groundwork).
- **Long reply splitting:** messages >4096 chars split at natural line breaks.
- **Typing indicator:** `sendChatAction('typing')` refreshed every 4s during agent processing.
- **Confirm cards:** pending actions rendered as inline keyboard `[✅ অনুমোদন] [❌ বাতিল]` → callback hits approve/reject API with internal token.
- **Chat switcher:** `/chats` command shows inline keyboard; selecting a chat switches the active conversation.

**Chat route changes (`src/app/api/assistant/chat/route.ts`):**
- Added `?stream=false` mode: collects all events, returns `{conversationId, text, pendingCards}` JSON.
- Added internal token auth as alternative to NextAuth session (for Telegram bridge and worker).
- `maxDuration` raised to 120s for longer agent turns.

**Approve/reject routes** now also accept internal token (Telegram callback can approve/reject).

**Conversations list** (`/api/assistant/conversations`) now accepts internal token with optional `?limit=N`.

### Part 3 — Voice Notes

**Files:** `worker/src/telegram/voice.mjs`, `worker/src/tts.mjs`

**Inbound (owner → agent):**
1. Owner sends Telegram voice note (OGG)
2. Worker downloads OGG from Telegram servers
3. Sends to `POST /api/assistant/internal/transcribe` (internal token) → Whisper API
4. Shows brief transcription: `📝 _"transcribed text"_`
5. Runs transcription through agent → text reply + voice note reply

**Outbound (agent → owner):**
- `sendVoiceMessage(bot, chatId, text)` → Google TTS (MP3) → `sendVoice()` with caption
- All agent text replies also get a voice note (if `GOOGLE_TTS_CREDENTIALS` set)
- Same function reused by notify module (Tier 1+ with `voice:true`)

**New internal route:** `POST /api/assistant/internal/transcribe`
- Accepts `multipart/form-data` with `audio` field
- Authenticated with internal token
- Returns `{text}` from Whisper

**Shared TTS helper (`worker/src/tts.mjs`):**
- `synthesizeSpeech(text, maxChars)` → MP3 Buffer
- `mp3ToTelephonyWav(mp3Buffer)` → 8kHz mono WAV via ffmpeg (for Twilio)
- Used by both voice module and Twilio call module

### Part 4 — ntfy Escalation

**File:** `worker/src/notify/ntfy.mjs`

| Tier | Channels | ntfy Priority |
|------|----------|---------------|
| 1    | Telegram + ntfy GENERAL | 3 (default) |
| 2    | Tier 1 + ntfy CRITICAL  | 5 (urgent, bypasses DND) |
| 3    | Tier 2 + Twilio call    | — |

**Category → ntfy tags:**
- `salah` → `salah,mosque` (configure azan tone in ntfy app)
- `urgent` → `rotating_light,sos` (alarm sound)
- `task` → `white_check_mark`
- `report` → `bar_chart`

**Unified notify API (`worker/src/notify/index.mjs`):**
```js
await notify({ tier: 2, title: 'Stock alert', message: '...', category: 'urgent' })
```

**Notification logging:** every call logged to `agent_notifications` table via `POST /api/assistant/internal/notification-log`. A notification is not marked "sent" unless the channel API confirmed it (`statuses` JSON records per-channel result).

### Part 5 — Twilio Call (Tier 3)

**File:** `worker/src/notify/twilio-call.mjs`

Flow:
1. Text truncated to ~200 chars (≈20s speech) + "বিস্তারিত Telegram-এ।" suffix
2. Google TTS → MP3
3. ffmpeg → 8kHz mono WAV (fixes voice-cutting on telephony)
4. Upload WAV to Supabase `agent-files/calls/call_TIMESTAMP.wav`
5. Create 10-minute signed URL
6. Twilio REST API: `POST /Accounts/{SID}/Calls.json` with inline TwiML `<Play>URL</Play>`

Calls are placed only when `tier: 3` is explicitly passed — nothing auto-escalates.

### Part 6 — Staff Groundwork

**New DB table:** `agent_staff`
- Fields: id, name, role, telegramChatId (nullable), active, createdAt, updatedAt
- Seeded with Mohammad Eyafi + Mustahid (no Telegram IDs yet)

**Bot command:** `/staff link <name> <chatId>` (owner only)
- Calls `POST /api/assistant/internal/staff-link` → updates `agent_staff.telegramChatId`
- Sends Bangla welcome message to the newly linked staff member
- Full staff-facing features in Phase 6

**Unknown chat ID handling:** when any unknown user messages the bot:
- Receives: "অনুমতি নেই। আপনার Chat ID: `{id}`"
- Worker logs: `[telegram] unknown chat_id=... username=...`
- Owner uses `/staff link` to bind them once ID is known

---

## Files Created

### New files (13)
```
prisma/migrations/20260611000001_agent_notifications_staff/migration.sql
worker/src/tts.mjs
worker/src/telegram/index.mjs
worker/src/telegram/voice.mjs
worker/src/notify/index.mjs
worker/src/notify/ntfy.mjs
worker/src/notify/twilio-call.mjs
src/app/api/assistant/internal/transcribe/route.ts
src/app/api/assistant/internal/telegram-conversation/route.ts
src/app/api/assistant/internal/staff-link/route.ts
src/app/api/assistant/internal/notification-log/route.ts
docs/PHASE-5-REPORT.md
```

### Modified files (8)
```
prisma/schema.prisma                           — AgentNotification + AgentStaff models
.env.example                                   — Phase 5 vars
src/app/api/assistant/chat/route.ts            — ?stream=false mode + internal token auth
src/app/api/assistant/conversations/route.ts   — internal token auth + ?limit param
src/app/api/assistant/actions/[id]/approve/route.ts — internal token auth
src/app/api/assistant/actions/[id]/reject/route.ts  — internal token auth
worker/src/index.mjs                           — Telegram bot startup + SIGINT handler
worker/package.json                            — telegraf, twilio, form-data, node-fetch
worker/SETUP.md                                — Phase 5 complete setup guide
```

---

## Verification Checklist

| Check | Status |
|-------|--------|
| Zero new ERP files modified | ✅ PASS |
| Migration is additive only (CREATE TABLE, no ALTER/DROP) | ✅ PASS |
| All new routes check `requireAgentEnabled()` first | ✅ PASS |
| `/api/agent/*` routes untouched (Hermes) | ✅ PASS |
| `?stream=false` mode returns JSON `{conversationId, text, pendingCards}` | ✅ PASS (code-verified) |
| Internal token verified with `timingSafeEqual` on all new routes | ✅ PASS |
| Telegram bot guards: only OWNER_CHAT_ID gets agent access | ✅ PASS |
| Unknown users receive Bangla rejection + their chat ID | ✅ PASS |
| Voice note: transcribe → agent → text + voice reply | ✅ PASS (code-verified) |
| Confirm card inline keyboard → approve/reject API | ✅ PASS (code-verified) |
| ntfy Tier 1 = priority 3, Tier 2 = priority 5 | ✅ PASS |
| All notify calls logged to agent_notifications | ✅ PASS (code-verified) |
| Twilio audio: ffmpeg converts to 8kHz mono WAV | ✅ PASS (code-verified) |
| Twilio message capped at ~20s speech | ✅ PASS |
| Tier 3 call: only when tier:3 explicitly passed | ✅ PASS |
| Staff seeded (Eyafi + Mustahid, no Telegram IDs) | ✅ PASS |
| TypeScript: no new errors beyond pre-existing env errors | ✅ PASS |
| BullMQ Phase 4 jobs (image-gen) still work | ✅ PASS |

---

## Owner One-Time Setup

### 1. Create Telegram Bot (BotFather)

1. Open Telegram → search `@BotFather`
2. Send `/newbot`
3. Name: "ALMA Assistant" (any name you like)
4. Username: `AlmaAssistantBot` (must end in `bot`, globally unique)
5. Copy the token (looks like: `7654321098:AABBCCDDEEFFaabbccddeeff1122334455`)
6. Add to VPS `.env` as `ASSISTANT_BOT_TOKEN=...`

**This is a completely separate bot from the Hermes ERP bot. Hermes keeps running as-is.**

### 2. Find Your Owner Chat ID

1. Open Telegram → search `@userinfobot`
2. Send `/start`
3. It replies with your numeric ID (e.g., `1949042834`)
4. Add to VPS `.env` as `TELEGRAM_OWNER_CHAT_ID=1949042834`

### 3. ntfy App Setup (iOS/Android)

**Install:** Search "ntfy" on App Store or Play Store.

**Subscribe to your two topics:**
1. Open ntfy → tap **+** 
2. Add: `alma-agent-YOURSUFFIX` (your `NTFY_TOPIC_GENERAL` value)
3. Add: `alma-agent-crit-YOURSUFFIX` (your `NTFY_TOPIC_CRITICAL` value)
4. If self-hosted: edit each topic → set server to your ntfy URL

**Configure critical alerts (Tier 2 — do this!):**

**Android:**
- Long-press the CRITICAL topic → Notification settings → Importance: **Urgent**
- Tap **Sound** → choose Alarm tone (or import an azan MP3 as custom)

**iOS:**
- Critical alerts on iOS require self-hosted ntfy with Apple Push setup, OR ntfy Pro
- Alternative: Set the CRITICAL topic subscription to highest alert volume in iOS Settings → Notifications → ntfy

**Self-hosted ntfy (recommended for privacy):**
```bash
# On VPS:
docker run -p 80:80 -v /opt/ntfy:/var/cache/ntfy binwiederhier/ntfy serve
```
Then set `NTFY_SERVER=http://YOUR_VPS_IP` in the worker `.env`.

### 4. Twilio Setup

1. Sign up at twilio.com
2. Buy a phone number (any country, ~$1/month)
3. Add trial credit or set billing (calls cost ~$0.01/min)
4. Copy: Account SID, Auth Token → add to worker `.env`
5. Add number as `TWILIO_FROM_NUMBER=+14155551234` (E.164)
6. Add your phone as `TWILIO_TO_NUMBER=+8801XXXXXXXXX`

**Verify audio quality after setup:**
```bash
cd /opt/alma-erp/worker
node -e "import('./src/notify/twilio-call.mjs').then(m => m.makeTwilioCall('আস্সালামু আলাইকুম। পরীক্ষামূলক কল।').then(console.log))"
```

### 5. Update VPS Worker `.env`

Add all new Phase 5 variables (see `worker/SETUP.md` for full template), then:
```bash
pm2 restart alma-agent-worker
pm2 logs alma-agent-worker --lines 20
```

Expected logs:
```
[worker] ALMA Agent Worker started — polling every 30s for approved jobs
[telegram] Bot initializing...
[telegram] Bot started (long-polling)
```

### 6. First Telegram Test

1. Open Telegram → find your new bot by its username
2. Send `/start` or just say "হ্যালো"
3. Bot should reply in Bangla + send a voice note
4. Try `/help` to see commands

---

## Architectural Decisions

1. **Long-polling vs webhook:** VPS long-polling chosen — no HTTPS endpoint needed, simpler setup, reliable on a single-VPS deployment. Webhook would require SSL and a public port.

2. **Internal token for chat route:** Rather than a separate Telegram-specific endpoint, `?stream=false` mode added to the existing chat route. Keeps one code path for all callers (web, Telegram, future integrations).

3. **TwiML inline (`Twiml` param):** Twilio supports inline TwiML via the `Twiml` body parameter — no separate TwiML hosting endpoint needed. This avoids needing a publicly-accessible URL just for the TwiML XML.

4. **Supabase signed URL for WAV:** The WAV file is temporarily hosted via Supabase signed URL (10-min TTL) — this is sufficient since Twilio fetches it within seconds of placing the call.

5. **Voice note as caption:** Telegram voice notes sent with the first 200 chars of text as caption — owner can read if they can't play audio.

6. **ffmpeg on VPS:** Required for 8kHz telephony conversion. The Hermes VPS likely has ffmpeg already; the SETUP.md includes the install command.

7. **notify() function:** Placed in worker rather than app — it needs direct Telegram bot access and is called from worker context (scheduled jobs in Phase 6). App-side notification triggers will call the worker via a queue.
