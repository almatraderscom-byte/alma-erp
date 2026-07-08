# ALMA Agent Worker — VPS Setup Guide

Ubuntu 22.04+, Node.js 20+. Copy-paste each block in order.

---

## 1. Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # should print v20.x.x
```

## 2. Install Redis

```bash
sudo apt-get install -y redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
redis-cli ping   # should print PONG
```

## 3. Install ffmpeg (Phase 5 — Twilio telephony audio)

```bash
sudo apt-get install -y ffmpeg
ffmpeg -version   # verify install
```

ffmpeg converts Google TTS MP3 → 8 kHz mono WAV (Twilio telephony format).
This fixes the voice-cutting issue on phone calls.

## 4. Install pm2

```bash
sudo npm install -g pm2
pm2 startup   # follow the printed command to enable on reboot
```

## 5. Clone / pull the repo

```bash
# If this is a fresh server:
git clone https://github.com/almatraderscom-byte/alma-erp.git /opt/alma-erp
cd /opt/alma-erp/worker

# If already cloned, just pull:
cd /opt/alma-erp && git pull origin main
cd worker
```

## 6. Install worker dependencies

```bash
cd /opt/alma-erp/worker
npm ci
```

## 7. Create the worker .env file

```bash
cat > /opt/alma-erp/worker/.env << 'EOF'
# ── Core (Phase 4) ──────────────────────────────────────────────────────────
REDIS_URL=redis://127.0.0.1:6379
APP_URL=https://alma-erp-six.vercel.app
AGENT_INTERNAL_TOKEN=<generate with: openssl rand -hex 32>
GEMINI_API_KEY=
# FASHN AI — Pro fashion try-on / product-to-model image generation (Creative Studio).
# REQUIRED for best-realism image jobs: the worker drains image_gen jobs and calls FASHN
# directly, so the SAME key set in Vercel must also live here. Get key: https://fashn.ai/products/api
FASHN_API_KEY=
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=

# ── Phase 5 — Telegram Bot ───────────────────────────────────────────────────
# New bot — NOT the Hermes ERP bot. Create via BotFather (/newbot).
ASSISTANT_BOT_TOKEN=
TELEGRAM_OWNER_CHAT_ID=    # Your personal Telegram chat ID (see "Find your chat ID" below)

# ── Phase 5 — Google TTS (Bangla voice notes) ───────────────────────────────
# Paste the full JSON of your Google Cloud service account key as ONE line (no line breaks).
# If the key has quotes, wrap the whole value in single quotes in .env:
# GOOGLE_TTS_CREDENTIALS='{"type":"service_account",...}'
# Same account as Vercel's GOOGLE_TTS_CREDENTIALS.
GOOGLE_TTS_CREDENTIALS=

# ── Phase 5 — OpenAI Whisper (voice-to-text) ─────────────────────────────────
OPENAI_API_KEY=

# ── Cartesia bridge — two-way calls in a natural Bangla voice ────────────────
# Runs only when VOICE_CALL_PROVIDER=cartesia (set BOTH here and in Vercel).
# Needs GEMINI_API_KEY + OPENAI_API_KEY above too (Gemini = brain, OpenAI = ears).
# Get the key: https://play.cartesia.ai → API Keys.
CARTESIA_API_KEY=
# Pick a Bangla voice at https://play.cartesia.ai (filter language: Bengali),
# copy its voice ID (UUID).
CARTESIA_VOICE_ID=
VOICE_CALL_PROVIDER=cartesia
# VOICE_BRIDGE_PORT=3101             # VPS-local port; expose behind HTTPS (Caddy),
#                                    # then set VOICE_BRIDGE_PUBLIC_WSS_URL in Vercel
# CARTESIA_TTS_MODEL=sonic-3         # or sonic-3.5 / sonic-latest
# VOICE_BRIDGE_VAD_SILENCE_MS=900    # how long the caller must pause before the agent replies
# VOICE_BRIDGE_TURN_GRACE_MS=400     # extra merge window for split utterances
# Smoke test after filling keys: node scripts/test-cartesia-bridge.mjs

# ── Phase 5 — ntfy push notifications ───────────────────────────────────────
# Self-hosted recommended for privacy: https://docs.ntfy.sh/install/
# Or use free tier: https://ntfy.sh (public — use random topic names)
NTFY_SERVER=https://ntfy.sh
NTFY_TOPIC_GENERAL=alma-agent-RANDOMSUFFIX
NTFY_TOPIC_CRITICAL=alma-agent-crit-RANDOMSUFFIX

# ── Phase 5 — Twilio (Tier 3 phone calls) ───────────────────────────────────
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=+14155551234    # Your Twilio number (E.164)
TWILIO_TO_NUMBER=+8801XXXXXXXXX   # Owner's phone (E.164)

# ── Facebook (Phase 4) ───────────────────────────────────────────────────────
FB_PAGE_TOKEN_LIFESTYLE=
FB_PAGE_TOKEN_ONLINESHOP=
EOF
```

Edit the file and fill in all values:
```bash
nano /opt/alma-erp/worker/.env
```

## 8. Start the worker with pm2

```bash
cd /opt/alma-erp/worker
npm ci   # includes @sentry/node for Phase 7

# Recommended: ecosystem file sets max_memory_restart (512M) and process name agent-worker
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs agent-worker --lines 30   # verify heartbeats + Telegram started
```

**Survive reboots:** after `pm2 startup` (step 4), every `pm2 save` persists the process list across VPS restarts.

## 8b. Phase 7 — nightly backups (cron 03:00 UTC / 09:00 BD)

Dumps **agent + finance + lifestyle operational tables** (Postgres source of truth
since GAS migration) to `/opt/agent-backups/agent_finance_*.sql.gz` (14-day retention).

Included lifestyle tables: `lifestyle_orders`, `lifestyle_order_items`,
`lifestyle_products`, `lifestyle_stock_items`, `lifestyle_customers`,
`lifestyle_promos`, `lifestyle_invoice_sequences`.

```bash
sudo mkdir -p /opt/agent-backups
sudo chown "$USER:$USER" /opt/agent-backups
chmod +x /opt/alma-erp/scripts/agent-backup.sh

# Add to crontab (loads worker .env for DATABASE_URL):
(crontab -l 2>/dev/null; echo '0 3 * * * set -a && . /opt/alma-erp/worker/.env && set +a && /opt/alma-erp/scripts/agent-backup.sh') | crontab -
```

Restore to scratch schema:
```bash
gunzip -c /opt/agent-backups/agent_finance_YYYYMMDD_HHMMSS.sql.gz | psql "$SCRATCH_DATABASE_URL"
```

---

## Find your Telegram chat ID

1. Open Telegram and search for `@userinfobot`
2. Send `/start`
3. It replies with your user ID — paste that as `TELEGRAM_OWNER_CHAT_ID`

---

## ntfy app setup (iOS/Android)

### Install
- iOS: App Store → "ntfy"
- Android: Play Store → "ntfy" (or F-Droid)

### Subscribe to topics
1. Open ntfy app → **+** button
2. Add topic: `alma-agent-RANDOMSUFFIX` (your NTFY_TOPIC_GENERAL value)
3. Add topic: `alma-agent-crit-RANDOMSUFFIX` (your NTFY_TOPIC_CRITICAL value)
4. If using self-hosted: tap the topic → Edit → set server URL

### Configure critical alerts (Tier 2 — important!)
For the CRITICAL topic to bypass Do Not Disturb:

**Android:**
1. Long-press the critical topic → Notification settings
2. Set importance to **Urgent**
3. Assign a sound (e.g. alarm or custom azan tone)

**iOS:**
1. Tap the critical topic → Edit
2. Enable **Critical alerts** toggle (requires ntfy Pro or self-hosted with iOS push)
3. This bypasses Silent/DND mode

### Custom sounds by category
- `salah` alerts → set azan tone for that topic
- `urgent` alerts → set alarm/siren sound
- `task`/`report` → default notification sound

---

## Twilio audio test

After setup, verify the call quality with a test:

```bash
cd /opt/alma-erp/worker
node -e "
import('./src/notify/twilio-call.mjs').then(m =>
  m.makeTwilioCall('আস্সালামু আলাইকুম। এটি একটি পরীক্ষামূলক কল।')
    .then(r => console.log(r))
)"
```

You should hear clear Bangla audio on the phone. If audio is garbled, verify ffmpeg is installed:
```bash
ffmpeg -version
```

---

## BotFather setup (new Telegram bot)

1. Open Telegram → search `@BotFather`
2. Send `/newbot`
3. Pick a name: "ALMA Assistant" (or any name)
4. Pick a username: `AlmaAssistantBot` (must end in `bot`, must be unique)
5. BotFather gives you a token like `7654321098:AABBCCDDEEFFaabbccddeeff1122334455`
6. Paste this as `ASSISTANT_BOT_TOKEN` in the worker `.env`
7. Send `/setprivacy` → select your bot → Disable (so bot can see all messages in groups — not needed now but good for Phase 6)

**Important:** This is a DIFFERENT bot from the Hermes ERP bot. Do not reuse Hermes's token.

---

## GitHub Secrets (for auto-deploy)

Add these two secrets in the repo at **Settings → Secrets → Actions**:

| Secret name   | Value                                                         |
|---------------|---------------------------------------------------------------|
| `VPS_HOST`    | Your VPS IP or hostname (e.g. `31.97.237.40`)                |
| `VPS_SSH_KEY` | The private SSH key that can log in as `root` (or your user) |

After adding the secrets, every push to `main` that touches `worker/**` will automatically:
1. SSH to the VPS
2. `git pull`
3. `npm ci` in `worker/`
4. `pm2 restart alma-agent-worker`

---

## Verify everything is running

```bash
pm2 status
redis-cli ping
pm2 logs alma-agent-worker --lines 20
```

Expected log lines:
```
[worker] ALMA Agent Worker started — polling every 30s for approved jobs
[telegram] Bot initializing...
[telegram] Bot started (long-polling)
```

---

## Troubleshooting

- **Worker exits immediately**: Check `pm2 logs alma-agent-worker` for missing env vars
- **Redis connection refused**: `sudo systemctl start redis-server`
- **Telegram bot offline**: Check `ASSISTANT_BOT_TOKEN` is correct; ensure only one instance is running (`pm2 status`)
- **Voice notes silent**: Verify `GOOGLE_TTS_CREDENTIALS` is valid JSON in the `.env`
- **Twilio call robotic/cutting**: Ensure ffmpeg is installed (`ffmpeg -version`); it converts audio to 8 kHz mono
- **ntfy not received**: Check topic names match exactly; verify phone has notification permissions for the ntfy app
- **Image gen fails**: Verify `GEMINI_API_KEY` is valid
- **Job-result callback 401**: `AGENT_INTERNAL_TOKEN` must match the value set in Vercel environment variables
