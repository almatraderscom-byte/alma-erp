/**
 * Place a TWO-WAY NextGenSwitch (infosoftbd) call into the GEMINI LIVE bot
 * (scripts/gemini-live-bot.mjs :8766) — the owner-locked two-way engine
 * (gemini-3.1-flash-live, male=Charon / female=Aoede, native barge-in, DELETE hang-up).
 *
 * Mirrors EXACTLY what voice-call.ts placeNgsLiveCall sends, so a successful run here
 * proves the production path. Signs id/exp/t with AGENT_INTERNAL_TOKEN so the bot's
 * start-frame auth (Phase 0) accepts it. Secrets via env; run on the VPS worker:
 *   NGS_KEY=.. NGS_SECRET=.. NGS_TO=01779640373 node -r dotenv/config scripts/ngs-glive-call.mjs
 * Optional: GLIVE_WS (default ws://31.97.237.40:8766/ws — set wss://… to test TLS),
 *           CALL_VOICE (Charon|Aoede), CALL_PURPOSE, GLIVE_RECIPIENT.
 */
import { createHmac } from 'crypto'

const env = process.env
for (const k of ['NGS_KEY', 'NGS_SECRET', 'AGENT_INTERNAL_TOKEN']) {
  if (!env[k]) { console.error('MISSING', k); process.exit(1) }
}
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')

const API = (env.NGS_API_BASE || 'https://alma-traders.infosoftbd.com').replace(/\/$/, '')
const WS = env.GLIVE_WS || 'ws://31.97.237.40:8766/ws'
const TO = env.NGS_TO || '01779640373'
const FROM = env.NGS_FROM || '2323'
const VOICE = env.CALL_VOICE || 'Charon' // male; female = Aoede
const RECIPIENT = env.GLIVE_RECIPIENT || 'Maruf boss'
const PURPOSE = env.CALL_PURPOSE || 'এটি একটি টেস্ট কল — Phase 0 auth যাচাই। বসকে সংক্ষেপে সালাম দিয়ে জিজ্ঞেস করো কেমন আছেন, দুই-এক লাইন কথা বলো, তারপর বস চাইলে ভদ্রভাবে কল শেষ করো।'

const id = 'glive-' + Date.now()
const exp = Date.now() + 15 * 60 * 1000
const t = createHmac('sha256', env.AGENT_INTERNAL_TOKEN).update(`relay:${id}:${exp}`).digest('hex')
const P = (n, v) => `<parameter name="${esc(n)}" value="${esc(v)}"/>`

const responseXml = '<?xml version="1.0" encoding="UTF-8"?>' +
  `<response><connect><stream name="alma" url="${esc(WS)}">` +
  P('id', id) + P('exp', String(exp)) + P('t', t) +
  P('purpose', PURPOSE) + P('recipientName', RECIPIENT) + P('voice', VOICE) +
  '</stream></connect></response>' // hang-up via DELETE /api/v1/call/{id}, not a trailing verb

const body = new URLSearchParams({ to: TO, from: FROM, responseXml })
const res = await fetch(`${API}/api/v1/call`, {
  method: 'POST',
  headers: { 'X-Authorization': env.NGS_KEY, 'X-Authorization-Secret': env.NGS_SECRET, 'Content-Type': 'application/x-www-form-urlencoded' },
  body,
})
console.log('HTTP', res.status, '| id', id, '| voice', VOICE, '| ws', WS, '| to', TO)
console.log((await res.text()).slice(0, 300))
