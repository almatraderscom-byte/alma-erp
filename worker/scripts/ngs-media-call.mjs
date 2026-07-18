/**
 * Place a TWO-WAY NextGenSwitch (infosoftbd) call into the PRODUCTION Sarvam pipeline
 * (voice-relay /ngs-media → SarvamCall: barge-in, deterministic hang-up, mis-hear
 * guard, half-duplex, post-call report). Mirrors what voice-call.ts placeNgsMediaCall
 * will send. Secrets via env; run on the VPS worker:
 *   NGS_KEY=.. NGS_SECRET=.. node -r dotenv/config scripts/ngs-media-call.mjs
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
const WSS = env.RELAY_WSS || 'wss://31-97-237-40.sslip.io/ngs-media'
const TO = env.NGS_TO || '01779640373'
const FROM = env.NGS_FROM || '2323'
const SPEAKER = env.CALL_SPEAKER || 'anushka'
const TTSMODEL = env.CALL_TTS_MODEL || 'bulbul:v2'

const id = 'ngs-' + Date.now()
const exp = Date.now() + 15 * 60 * 1000
const t = createHmac('sha256', env.AGENT_INTERNAL_TOKEN).update(`relay:${id}:${exp}`).digest('hex')

const first = env.CALL_GREETING || 'আসসালামু আলাইকুম বস। আমি আপনার পার্সোনাল এজেন্ট বলছি। বাংলাদেশি নম্বরে, আমাদের নিজের সিস্টেম থেকে, আমার নিজের কণ্ঠে এখন দুই-মুখী কথা চলছে। যা খুশি জিজ্ঞেস করুন — আমি ছোট করে পরিষ্কার বাংলায় উত্তর দেব।'
const purpose = env.CALL_PURPOSE || 'এটি একটি টেস্ট কল। বসকে দেখাতে হবে দুই-মুখী কথা কত স্বাভাবিক, পরিষ্কার আর প্রফেশনাল। বসের প্রতিটি কথা মন দিয়ে শুনে ছোট, সঠিক ও ভদ্র উত্তর দাও।'
const P = (n, v) => `<parameter name="${n}" value="${esc(v)}"/>`

const responseXml = '<?xml version="1.0" encoding="UTF-8"?>' +
  `<response><connect><stream name="alma" url="${esc(WSS)}">` +
  P('id', id) + P('exp', String(exp)) + P('t', t) +
  P('firstMessage', first) + P('purpose', purpose) + P('recipientName', 'Maruf boss') +
  P('speaker', SPEAKER) + P('ttsModel', TTSMODEL) +
  '</stream></connect></response>' // hang-up is done via DELETE /api/v1/call/{id}, not a trailing verb

const body = new URLSearchParams({ to: TO, from: FROM, responseXml })
const res = await fetch(`${API}/api/v1/call`, {
  method: 'POST',
  headers: { 'X-Authorization': env.NGS_KEY, 'X-Authorization-Secret': env.NGS_SECRET, 'Content-Type': 'application/x-www-form-urlencoded' },
  body,
})
console.log('HTTP', res.status, '| id', id, '| voice', SPEAKER + '/' + TTSMODEL, '| to', TO)
console.log((await res.text()).slice(0, 300))
