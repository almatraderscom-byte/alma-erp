/**
 * NextGenSwitch (infosoftbd) test-call helper.
 *
 *   MODE=play   (default) one-way connectivity proof: Sarvam Bangla TTS → hosted
 *               audio → <play> → <hangup>. Proves the trunk actually terminates to
 *               a BD mobile + shows the BD caller-ID (the exact wall ePBX/Amber hit).
 *   MODE=stream two-way: <connect><stream> to our voice-relay (needs the NGS adapter
 *               deployed — see server.mjs /ngs-media).
 *
 * Secrets come from env ONLY (never hard-coded). Run on the VPS worker:
 *   NGS_KEY=.. NGS_SECRET=.. NGS_TO=01779640373 NGS_MODE=play \
 *     node -r dotenv/config scripts/ngs-test-call.mjs
 */
import { createClient } from '@supabase/supabase-js'
import { createHmac } from 'crypto'
import { buildProxiedAudioUrl, getTwilioPublicBase } from '../src/twilio-http.mjs'

const env = process.env
for (const k of ['NGS_KEY', 'NGS_SECRET', 'NGS_TO']) {
  if (!env[k]) { console.error('MISSING', k); process.exit(1) }
}

const BASE = (env.NGS_BASE || 'https://alma-traders.infosoftbd.com').replace(/\/$/, '')
const FROM = env.NGS_FROM || '09649777738'
const TO = env.NGS_TO
const MODE = env.NGS_MODE || 'play'
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')

async function sarvamAudioUrl(text) {
  const r = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: { 'api-subscription-key': env.SARVAM_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, target_language_code: 'bn-IN', model: 'bulbul:v2', speaker: 'anushka', speech_sample_rate: 8000 }),
  })
  const j = await r.json()
  if (!j.audios?.[0]) throw new Error('TTS_FAIL ' + JSON.stringify(j).slice(0, 180))
  const wav = Buffer.from(j.audios[0], 'base64')
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
  const path = `calls/ngs_${Date.now()}.wav`
  const { error } = await supabase.storage.from('agent-files').upload(path, wav, { contentType: 'audio/wav', upsert: true })
  if (error) throw new Error('UPLOAD_FAIL ' + error.message)
  return buildProxiedAudioUrl(getTwilioPublicBase(), path, 3600)
}

let responseXml
if (MODE === 'play') {
  const msg = env.NGS_MSG || 'আসসালামু আলাইকুম বস। আমি আপনার পার্সোনাল এজেন্ট বলছি, বাংলাদেশি নম্বর থেকে। এটা একটা টেস্ট কল। আমার কণ্ঠ পরিষ্কার শুনতে পেলে জানাবেন। ধন্যবাদ।'
  const audio = await sarvamAudioUrl(msg)
  console.log('AUDIO_URL=' + audio)
  responseXml = `<response><play>${esc(audio)}</play><hangup/></response>`
} else {
  const WSS = env.RELAY_WSS || 'wss://31-97-237-40.sslip.io/ngs-media'
  const id = 'ngs-' + Date.now(), exp = Date.now() + 15 * 60 * 1000
  const t = createHmac('sha256', env.AGENT_INTERNAL_TOKEN).update(`relay:${id}:${exp}`).digest('hex')
  const greeting = env.NGS_MSG || 'আসসালামু আলাইকুম বস। আমি আপনার এজেন্ট বলছি। যা খুশি জিজ্ঞেস করুন, আমি পরিষ্কার বাংলায় ছোট করে উত্তর দেব।'
  responseXml = '<response><connect>' +
    `<stream url="${esc(WSS)}">` +
    `<parameter name="id" value="${esc(id)}"/>` +
    `<parameter name="exp" value="${exp}"/>` +
    `<parameter name="t" value="${esc(t)}"/>` +
    `<parameter name="firstMessage" value="${esc(greeting)}"/>` +
    `<parameter name="recipientName" value="Maruf boss"/>` +
    '</stream></connect></response>'
}

console.log('POST', `${BASE}/api/v1/call`, '| to', TO, '| from', FROM, '| mode', MODE)
const body = new URLSearchParams({ to: TO, from: FROM, responseXml })
if (env.NGS_STATUS_CB) body.set('statusCallback', env.NGS_STATUS_CB)
const res = await fetch(`${BASE}/api/v1/call`, {
  method: 'POST',
  headers: {
    'X-Authorization': env.NGS_KEY,
    'X-Authorization-Secret': env.NGS_SECRET,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body,
})
const text = await res.text()
console.log('HTTP', res.status)
console.log('RESP', text.slice(0, 800))
