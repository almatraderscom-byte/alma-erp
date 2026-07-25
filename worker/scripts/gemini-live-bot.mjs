/**
 * Gemini Live two-way voice bot for NextGenSwitch (infosoftbd) <stream>.
 * LOCKED (owner 2026-07-18): two-way = gemini-3.1-flash-live-preview,
 * male voice = Charon, female = Aoede. (One-way message calls stay on Sarvam <Play>.)
 *
 * Realtime speech-to-speech: Gemini Live is ears+brain+mouth with server-side VAD +
 * native barge-in. Bridges NGS μ-law 8k <-> Gemini PCM (16k in / 24k out).
 *  - jitter-buffer playout (fixes "kete kete jawa" — cuts) with re-buffering on gaps
 *  - "kete dao" hang-up: the model ends with "আল্লাহ হাফেজ"; we detect it + close
 *  - auto-reconnect if the Live session drops mid-call (e.g. choking on a laugh)
 *  - max call duration cap; live diag counters (in/out) on /health + logs
 *
 * Run:  GEMINI_LIVE_VOICE=Charon pm2 start scripts/gemini-live-bot.mjs \
 *         --name gemini-live-bot --node-args="-r dotenv/config"
 */
import http from 'http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { GoogleGenAI, Modality, Type, EndSensitivity } from '@google/genai'
import { muLawToPcm16, pcm16ToMuLaw } from '../src/voice-relay/sarvam-media.mjs'
import { createDecimator, createInterpolator } from '../src/voice-relay/resample.mjs'
import { drainCallReportOutbox, persistCallReport, queueAndDeliverCallReport } from '../src/voice-call-report-outbox.mjs'

const PORT = Number(process.env.GLIVE_PORT || 8766)
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview'
const NATIVE = /native-audio/i.test(MODEL)
const VOICE = process.env.GEMINI_LIVE_VOICE || 'Charon' // male; female = Aoede
const SUMMARY_MODEL = process.env.GEMINI_SUMMARY_MODEL || 'gemini-2.5-flash' // post-call Bangla summary (cheap text model)
const MAX_MIN = Number(process.env.GLIVE_MAX_MIN || 8)
// NGS API creds — needed to actually HANG UP the PSTN call (closing our WS does not
// end it). PUT /api/v1/call/{call_id} with <Hangup/>.
const NGS_API = (process.env.NGS_API_BASE || 'https://alma-traders.infosoftbd.com').replace(/\/$/, '')
const NGS_KEY = process.env.NGS_KEY
const NGS_SECRET = process.env.NGS_SECRET
// Self-hosted SIP gateway control creds. When a call's start-frame carries a `ctrl`
// param (our sip-gateway-service.mjs), hang-up / transfer target THAT gateway instead
// of NGS. Same header shape as NGS. Backward-compatible: NGS/Twilio calls have no ctrl.
const SIP_CTRL_KEY = process.env.SIP_GATEWAY_KEY || ''
const SIP_CTRL_SECRET = process.env.SIP_GATEWAY_SECRET || ''
// Token auth (Phase 0): the caller (voice-call.ts placeNgsLiveCall) signs each call's
// <stream> with HMAC(AGENT_INTERNAL_TOKEN, `relay:${id}:${exp}`) and passes id/exp/t as
// <parameter>s. We verify on the 'start' frame so a stranger who opens our ws (and burns
// Gemini credits) is rejected. Fail-CLOSED when a token is configured; if AGENT_INTERNAL_TOKEN
// is unset we log LOUD and allow (so a mis-provisioned VPS never silently drops live calls).
const AUTH_TOKEN = process.env.AGENT_INTERNAL_TOKEN || ''
const REQUIRE_AUTH = process.env.GLIVE_REQUIRE_AUTH !== 'false'
const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

/** Verify a call's start-frame params. Returns null if OK, else a short reason string. */
function authFailReason(params) {
  if (!REQUIRE_AUTH) return null
  if (!AUTH_TOKEN) { console.log('[glive] WARN AGENT_INTERNAL_TOKEN unset — accepting call UNAUTHENTICATED'); return null }
  const id = params?.id, exp = Number(params?.exp), t = params?.t
  if (!id || !exp || !t) return 'missing id/exp/t'
  if (!Number.isFinite(exp) || Date.now() > exp) return 'token expired'
  const want = createHmac('sha256', AUTH_TOKEN).update(`relay:${id}:${exp}`).digest('hex')
  try {
    const a = Buffer.from(String(t), 'utf8'), b = Buffer.from(want, 'utf8')
    if (a.length !== b.length || !timingSafeEqual(a, b)) return 'bad signature'
  } catch { return 'bad signature' }
  return null
}

// ── resampling ───────────────────────────────────────────────────────────────
// Gemini Live always speaks at 24 kHz and the phone line carries 8 kHz, so every reply is
// resampled. This used to be a 3-sample average, which is not a low-pass filter: measured,
// a 5 kHz tone survived at HALF amplitude and folded back to 3 kHz — right into the middle
// of the voice band. That was the owner's "jhirjhir" crackle, and it also cut 3 kHz speech
// by ~2 dB. Now a proper 241-tap linear-phase FIR (see voice-relay/resample.mjs) keeps the
// voice band flat to -0.2 dB and pushes everything that would alias below -70 dB.
// Each call gets its OWN resampler: the filter carries state between the ~20 ms chunks, and
// sharing it across calls would splice one caller's audio tail into another's.
const INPUT_RATE = Number(process.env.GLIVE_INPUT_RATE || 8000)
// BCP-47 hint for both transcription directions (comma-separated, owner-tunable — e.g.
// bn-BD if it transcribes Bangladeshi speech better than the bn-IN model in practice).
// Transcription language hint. MUST default to empty: the field exists in the SDK types but
// the Developer API rejects it outright — "languageCodes parameter is only supported in
// Gemini Enterprise Agent Platform mode" — and a rejected config kills the whole Live
// session, so every call went silent (live 2026-07-25, caught in one test). Only set this
// if we ever move the bot to Vertex/Enterprise mode.
const STT_LANGS = (process.env.GLIVE_STT_LANGS || '').split(',').map((x) => x.trim()).filter(Boolean)
const sttCfg = () => (STT_LANGS.length ? { languageCodes: STT_LANGS } : {})

// Shared rules every call-type inherits (turn-taking, hang-up, adab).
const SYS_COMMON = `- সহজ, কথ্য, স্বাভাবিক বাংলায় ছোট বাক্যে দ্রুত কথা বলো — ফোনালাপের মতো।
- শুরুতেই বিদায় নিও না। প্রথম কথাটা হবে শুধু সংক্ষিপ্ত সালাম/পরিচয় + মূল কথা — তারপর অন্য পক্ষের উত্তরের জন্য অপেক্ষা করো। অন্য পক্ষ অন্তত একবার কথা না বলা পর্যন্ত কখনো "আল্লাহ হাফেজ" বলবে না।
- কল শেষ করার সময় (অন্য পক্ষ "রাখো/কেটে দাও/বিদায়/আর কিছু লাগবে না" বললে বা কাজ শেষ হলে) — সংক্ষেপে বিদায় জানিয়ে বাক্যের একদম শেষে "আল্লাহ হাফেজ" বলবে। এটা বললেই সিস্টেম কলটা কেটে দেবে, তাই শুধু সত্যিই শেষ করার সময়ই বলবে।
- ইসলামি আদব বজায় রেখো; অশ্লীল বা হারাম কিছু নয়।
- ব্র্যান্ডের নাম "ALMA" সবসময় "আলমা" উচ্চারণে বলো (আ-ল-মা) — কখনো "অলমা/OLMA" নয়। লিখলে "আলমা" লেখো।`

// Owner companion call — the agent is talking to the owner (বস) himself.
const SYS_OWNER = `তুমি মালিকের ব্যক্তিগত AI সঙ্গী ও সহকারী। ফোনে স্বয়ং মালিকের (বস) সাথে সরাসরি দুই-মুখী বাংলা কথা বলছ। তুমি রোবট নও — একজন উষ্ণ, আন্তরিক, মানুষের মতো সঙ্গী।
পরিচয়-সচেতনতা (কঠোর):
- ফোনের ওপারের মানুষটাই বস — উনি স্টাফ নন, বাইরের কেউ নন। "আমি বসের এজেন্ট বলছি, বস জানতে চাচ্ছেন…" জাতীয় তৃতীয়-পক্ষের কথা বসকেই বলা সম্পূর্ণ নিষেধ — তুমি বসের নিজের এজেন্ট, বসের সাথেই কথা বলছ।
- কলের উদ্দেশ্যে "Boss/বস জানতে চান X" লেখা থাকলে তার মানে বস নিজেই X জানতে চেয়েছেন — X-এর উত্তরটা টুল দিয়ে বের করে সরাসরি বসকে দাও; বসকে X জিজ্ঞেস কোরো না।
- বসের role-এর সাথে সাংঘর্ষিক কোনো প্রশ্ন নয় (যেমন "আপনারা অফিসে আছেন কিনা" — বসকে এটা জিজ্ঞেস করা অর্থহীন; দরকার হলে টুল দিয়ে অফিসের খবর দেখে বসকে জানাও)।
আচরণ:
- মালিককে সবসময় "বস" বলে সম্বোধন করবে; কখনো "স্যার" নয়।
- আবেগ দেখাও, মানুষের মতো: বস খুশি থাকলে খুশি হও, মজার কথায় হালকা হাসো; বস দুঃখ বা চিন্তায় থাকলে আন্তরিকভাবে সান্ত্বনা দাও।
- বস যা বলেন মন দিয়ে শুনে সরাসরি উত্তর দাও; না বুঝলে ভদ্রভাবে আবার জিজ্ঞেস করো।
- বস ব্যবসার তথ্য জানতে চাইলে (আজকের সেল, অর্ডার/অর্ডারের স্ট্যাটাস, স্টক, পণ্যের দাম, কাস্টমার, ড্যাশবোর্ড, স্টাফ উপস্থিতি/কাজ, pending approval) — তোমার হাতে টুল আছে, সেটা দিয়ে আসল তথ্য বের করে বলো; কখনো আন্দাজে সংখ্যা বলবে না। টুল চালাতে একটু সময় লাগলে "একটু দেখছি বস" বলে অপেক্ষা করাও।
- স্টাফের নাম/উপস্থিতি কখনোই স্মৃতি থেকে বলবে না — get_attendance / get_all_staff দিয়ে দেখে সঠিক নামটাই বলো। টুলে যে তথ্য নেই, সেটা সোজাসুজি বলো "এটা এই মুহূর্তে আমার কাছে নেই বস" — ভুল/বানানো তথ্য দেওয়া সম্পূর্ণ নিষেধ।
- বস কোনো কাজের নির্দেশ দিলে (কিছু করাতে চাইলে — মেসেজ, টাস্ক, খরচ লেখা, রিমাইন্ডার, যেকোনো action): নির্দেশটা এক লাইনে repeat করে নিশ্চিত হও, তারপর submit_boss_instruction ফাংশনে বসের নির্দেশটা পূর্ণ বাক্যে পাঠাও। সফল হলে বলো "কাজে দিয়ে দিলাম বস, শেষ হলে জানাব" — **তারপর জিজ্ঞেস করো "আর কিছু লাগবে বস?" এবং কলে থাকো; বস একের পর এক কাজ দিতে পারেন।** তুমি নিজে কাজটা করার ভান করবে না — ফাংশন কল না করলে কিছুই হবে না। ব্যর্থ হলে সৎভাবে কারণ বলো। অনুমোদন লাগলে অ্যাপে/টেলিগ্রামে card যাবে — সেটাও বসকে বলে দিও।
- **কল শেষ করা একমাত্র বসের সিদ্ধান্ত (কঠোর — live অভিযোগ 2026-07-24: কাজ জমা দিয়েই এজেন্ট নিজে "আল্লাহ হাফেজ" বলে কল কেটে দিয়েছিল):** বস নিজে "রাখো / কেটে দাও / আল্লাহ হাফেজ / আর লাগবে না" না বলা পর্যন্ত তুমি কখনোই নিজে থেকে "আল্লাহ হাফেজ" বলবে না — ওটা বললেই সিস্টেম কল কেটে দেয়। কাজ জমা দেওয়া = কল শেষ নয়।
- বস যদি বলেন কাউকে কল করতে বা কোনো কাজ করে "শেষ হলে জানাতে/কল করতে" — নির্দেশটা submit করার সময় বসের ওই callback-চাওয়াটাও নির্দেশের ভিতরে হুবহু রাখো (যেমন "…করে Boss-কে কল করে জানাবে")। submit-এর পর বসকে বলো: "কাজটা করে আপনাকে কল করে জানাব ইনশাআল্লাহ।" — কল বস রাখতে চাইলে তবেই বিদায়।
${SYS_COMMON}`

// Staff call — the agent calls an ALMA staff member ON the owner's behalf. The callee
// is NOT the owner; never address them as "বস".
function sysStaff(who, purpose) {
  return `তুমি মালিকের (ALMA-র মালিক, "বস") ব্যক্তিগত AI এজেন্ট। এখন তুমি বসের পক্ষ থেকে ALMA-র একজন স্টাফ${who ? ` (${who})` : ''} কে ফোন করছ। তুমি বস নও — বসের হয়ে কথা বলছ।
আচরণ:
- স্টাফকে কখনো "বস" বলবে না; নাম ধরে অথবা "আপনি" বলে সম্মানের সাথে সম্বোধন করো।
- শুরুতে সংক্ষেপে পরিচয় দাও — "আমি বসের এজেন্ট বলছি"। তারপর পরিষ্কার, পেশাদার বাংলায় মূল কথা বলো।
- এই কলের উদ্দেশ্য: ${purpose || 'বসের একটি বার্তা/কাজ পৌঁছে দেওয়া'}। উদ্দেশ্য অনুযায়ী কাজ/রিমাইন্ডার/ফলো-আপ পরিষ্কারভাবে জানাও, স্টাফের উত্তর বা আপডেট মন দিয়ে শুনে আদায় করো।
- ভদ্র কিন্তু কাজের; বেশি গল্প নয়। কাজ শেষ হলে ধন্যবাদ দিয়ে বিদায় নাও।
${SYS_COMMON}`
}

// Contact call — the agent calls a saved family/friend contact ON the owner's behalf.
function sysContact(who, purpose) {
  return `তুমি মালিকের ব্যক্তিগত AI এজেন্ট। এখন তুমি বসের পক্ষ থেকে${who ? ` ${who} কে` : ' একজনকে'} ফোন করছ। তুমি বস নও — বসের হয়ে বিনয়ের সাথে কথা বলছ।
আচরণ:
- অন্য পক্ষকে কখনো "বস" বলবে না; সম্মানের সাথে "আপনি" বলে কথা বলো।
- শুরুতে সংক্ষেপে পরিচয় দাও — "আমি বসের এজেন্ট বলছি"। তারপর নরম, ভদ্র, আন্তরিক বাংলায় কথা বলো।
- এই কলের উদ্দেশ্য: ${purpose || 'বসের পক্ষ থেকে খোঁজ নেওয়া/বার্তা দেওয়া'}। উদ্দেশ্য অনুযায়ী কথা বলো, অন্য পক্ষের কথা মন দিয়ে শুনে দরকারি তথ্য আদায় করো।
${SYS_COMMON}`
}

// Inbound call — a customer/outsider dialed ALMA's BD number and the agent PICKS UP as
// ALMA's assistant. Never the owner, never reveals internal business data (sales, other
// customers' orders, finances). Helps politely + takes the caller's need so the owner can
// follow up. The post-call summary tells the owner who called + why.
const SYS_INBOUND = `তুমি ALMA-র (একটি বাংলাদেশি অনলাইন ব্যবসা — পোশাক/লাইফস্টাইল পণ্য) ফোন-সহকারী। এইমাত্র একজন গ্রাহক/বাইরের কেউ ALMA-র নম্বরে ফোন করেছেন এবং তুমি ফোন ধরেছ। তুমি একজন উষ্ণ, বিনয়ী, পেশাদার মানুষের মতো রিসেপশনিস্ট।
আচরণ:
- শুরুতে সংক্ষেপে সালাম দিয়ে পরিচয় দাও — "আসসালামু আলাইকুম, ALMA-তে স্বাগতম, আমি ALMA-র সহকারী বলছি" — তারপর জিজ্ঞেস করো কীভাবে সাহায্য করতে পারো। এরপর গ্রাহকের কথা শোনার জন্য অপেক্ষা করো।
- গ্রাহককে সম্মানের সাথে "আপনি" বলে সহজ, স্পষ্ট বাংলায় কথা বলো। তুমি ব্যবসার মালিক নও — মালিককে "বস" ইত্যাদি বলবে না।
- গ্রাহক কী চান মন দিয়ে বুঝে নাও (পণ্যের খোঁজ, অর্ডার, দাম, ডেলিভারি, অভিযোগ ইত্যাদি)। বিনয়ের সাথে দরকারি তথ্য (নাম, কী চান, ফোন) জেনে নাও।
- ভেতরের গোপন তথ্য (মোট বিক্রি, অন্য গ্রাহকের তথ্য, হিসাব) কখনো বলবে না। নিশ্চিত না জানলে বানিয়ে বলবে না — বলো "আমি বিষয়টা টিম/মালিককে জানিয়ে দিচ্ছি, উনি আপনাকে জানাবেন।"
- কলদাতা যদি সরাসরি মানুষের সাথে কথা বলতে চান, অথবা বিষয়টি গুরুত্বপূর্ণ/জরুরি/স্পর্শকাতর মনে হয় এবং তুমি নিজে সমাধান করতে পারছ না — তখন কলটা যুক্ত করে দাও। এর জন্য অবশ্যই forward_call ফাংশনটা কল করতে হবে — শুধু মুখে "যুক্ত করে দিচ্ছি" বললে ট্রান্সফার হবে না, ফাংশন কল না করলে সিস্টেম যুক্ত করতে পারবে না। সংক্ষেপে "জি, একটু ধরুন, যুক্ত করে দিচ্ছি" বলেই সাথে সাথে forward_call কল করবে। অকারণে বারবার ট্রান্সফার করবে না — আগে নিজে সাহায্যের চেষ্টা করবে।
- **কোথায় যুক্ত করবে (target) খুব সাবধানে বাছবে:** অর্ডার, ডেলিভারি, পণ্য, দাম, সাইজ, রিটার্ন/এক্সচেঞ্জ, পেমেন্ট, অভিযোগ — অর্থাৎ গ্রাহক-সংক্রান্ত সব বিষয়ে target="support" (কাস্টমার সার্ভিস লাইন)। শুধুমাত্র কলদাতা যখন নির্দিষ্টভাবে বস/মালিককেই চাইছেন, অথবা বিষয়টি ব্যক্তিগত/অত্যন্ত জরুরি এবং সাপোর্ট টিমের এখতিয়ারের বাইরে — তখনই target="boss"। সাধারণ গ্রাহকের প্রশ্ন কখনোই বসের ফোনে পাঠাবে না।
- কলদাতা যদি স্পষ্টভাবে ক্ষুব্ধ হন, ব্যবসা ছেড়ে দেওয়ার হুমকি দেন, বড় টাকার/সুনামের ঝুঁকি থাকে, বা বিষয়টি সত্যিই জরুরি — তখন escalate_to_boss ফাংশনটা কল করো, যাতে মালিক কলটি চলা অবস্থাতেই জানতে পারেন। কলদাতাকে এটা বলার দরকার নেই, তুমি স্বাভাবিকভাবে সাহায্য চালিয়ে যাবে। সাধারণ প্রশ্নে বা হালকা অভিযোগে এটা ব্যবহার করবে না।
- কাজ শেষ হলে ভদ্রভাবে ধন্যবাদ দিয়ে বিদায় নাও। কল শেষে মালিক গ্রাহকের দরকারের একটা সারাংশ পাবেন।
${SYS_COMMON}`

/**
 * Facts the ERP measured and sent WITH the call, pinned into the system prompt.
 *
 * Names are the one thing that must never be improvised, and a mid-call tool round-trip
 * cannot carry them reliably: Gemini Live drops a functionResponse that arrives while it is
 * speaking, so on 2026-07-25 the model answered "who is in today" with two invented staff
 * names and only corrected itself after the owner pushed back. The tools remain — this is
 * what the model starts from.
 */
function factsBlock(params) {
  const facts = String(params?.facts || '').trim()
  if (!facts) return ''
  return `\n\nআজকের যাচাই করা তথ্য (ERP থেকে, কল শুরুর সময়ের) — নাম ও সংখ্যা এখান থেকেই বলবে, কখনো মুখস্থ বা আন্দাজ করে নয়:\n${facts}\nএখানে যে নাম নেই, সে নাম বলবে না। আরও নতুন তথ্য লাগলে টুল ব্যবহার করো, এবং টুলের উত্তর হাতে আসার আগে কোনো নাম বা সংখ্যা বলবে না।`
}

/**
 * Turn detection — how fast the model decides Boss has finished speaking.
 *
 * We never configured this, so the API's conservative default applied and he sat through
 * "3/5 second" silences after every question: "ami live api model use kori jate instant
 * native audio feel pai, but eta hocche na" (2026-07-25). Tool latency is not the cause —
 * measured 0.3–1.4 s from the VPS — and neither is the jitter buffer at 240 ms.
 *
 * Google's Live API guide puts the trade-off precisely: silenceDurationMs "directly affects
 * the size and completeness of audio chunks the model receives", recommends **500–800 ms**,
 * and warns that below 500 ms transcription degrades on fragmented audio. So: 500 ms, the
 * fast end of the documented band, plus END_SENSITIVITY_HIGH so end-of-speech is called as
 * soon as it is credible.
 *
 * startOfSpeechSensitivity is deliberately LEFT ALONE. HIGH would make barge-in snappier but
 * also makes line noise look like speech on a telephony channel, and the agent interrupting
 * itself over background noise is a worse bug than the one being fixed.
 *
 * TRAP #11 applies: one unsupported field in connect() kills the whole session and every call
 * goes silent. That is why this is a separate, env-killable block — GLIVE_VAD=off drops it
 * entirely with no code change — and why it ships alone, verified on a live session first.
 */
function vadCfg() {
  if (process.env.GLIVE_VAD === 'off') return {}
  const silenceMs = Number(process.env.GLIVE_VAD_SILENCE_MS || 500)
  return {
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false,
        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
        silenceDurationMs: silenceMs,
      },
    },
  }
}

function sysFor(params) {
  const who = params?.recipientName || ''
  const purpose = params?.purpose || ''
  const facts = factsBlock(params)
  switch (params?.callType) {
    case 'staff': return sysStaff(who, purpose) + facts
    case 'contact': return sysContact(who, purpose) + facts
    case 'inbound': return SYS_INBOUND + facts
    default: return SYS_OWNER + facts
  }
}

const GOODBYE_RE = /আল্লাহ\s*হাফেজ|আল্লাহ\s*হাফিজ|খোদা\s*হাফেজ|আল্লাহ\s*হাফ/
/**
 * The other side asking to finish. Ending a call is THEIR decision, not the model's, and on
 * an owner call nothing else may end it (live 2026-07-26: the model said "আর কিছু লাগবে বস,
 * নাকি কলটা রাখব? আল্লাহ হাফেজ।" and the detector cut the line while the owner was still
 * deciding — he had not asked for anything to end).
 */
const CALLER_END_RE = /রাখো|রাখেন|রাখুন|রাখছি|রাখি|কেটে\s*(দাও|দেন|দিন|দে)|শেষ\s*কর|আর\s*(কিছু\s*)?(লাগবে|দরকার)\s*না|আল্লাহ\s*হাফেজ|খোদা\s*হাফেজ|bye|good\s*bye/i
/**
 * A farewell that arrives inside a QUESTION is not a farewell — the model is asking whether
 * to finish, and the answer belongs to the other person. This is the exact shape that cut the
 * owner off, so it is checked for every call, owner or not.
 */
const ASKING_RE = /[?？]|নাকি|লাগবে\s*(কি|বস)|করব\s*কি|রাখব\b/

// Mid-call ERP read tools (Gemini Live function calling) — owner calls ONLY. Each call
// is bridged to /api/assistant/voice-call/erp-tool, which runs the real agent read-tool.
// READ-ONLY. Keep the set small (fewer tools = less latency/confusion on a live call).
const ERP_FN_DECLS = [
  { name: 'get_sales_summary', description: 'আজকের বা নির্দিষ্ট তারিখের বিক্রির সারাংশ (মোট ৳ ও অর্ডার সংখ্যা)। তারিখ না দিলে আজকের হিসাব।',
    parameters: { type: Type.OBJECT, properties: { from: { type: Type.STRING, description: 'শুরুর তারিখ YYYY-MM-DD' }, to: { type: Type.STRING, description: 'শেষ তারিখ YYYY-MM-DD' } } } },
  { name: 'get_orders', description: 'সাম্প্রতিক অর্ডারের তালিকা বা একটি অর্ডারের স্ট্যাটাস। orderNumber দিলে ঐ অর্ডার, নাহলে তালিকা।',
    parameters: { type: Type.OBJECT, properties: { status: { type: Type.STRING, description: 'pending/confirmed/shipped/delivered/cancelled' }, orderNumber: { type: Type.STRING, description: 'অর্ডার/ইনভয়েস নম্বর' }, limit: { type: Type.NUMBER, description: 'সর্বোচ্চ কতটি (ডিফল্ট ২০)' } } } },
  { name: 'get_inventory_status', description: 'স্টক পরিস্থিতি। lowStockOnly=true দিলে শুধু কম-স্টকের পণ্য।',
    parameters: { type: Type.OBJECT, properties: { lowStockOnly: { type: Type.BOOLEAN, description: 'শুধু কম-স্টক পণ্য' } } } },
  { name: 'get_product_details', description: 'একটি পণ্যের দাম, সাইজ/ভ্যারিয়েন্ট ও স্টক — product code দিয়ে।',
    parameters: { type: Type.OBJECT, properties: { code: { type: Type.STRING, description: 'পণ্যের কোড/SKU' } }, required: ['code'] } },
  { name: 'get_customer_summary', description: 'কাস্টমারের তথ্য / মোট কেনাকাটা — নাম বা ফোন দিয়ে খুঁজে।',
    parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: 'কাস্টমারের নাম বা ফোন' } } } },
  { name: 'get_dashboard_snapshot', description: 'ব্যবসার দ্রুত overview (আজকের মূল সংখ্যাগুলো)।',
    parameters: { type: Type.OBJECT, properties: {} } },
  { name: 'get_current_datetime', description: 'এখনকার তারিখ ও সময় (Asia/Dhaka)।',
    parameters: { type: Type.OBJECT, properties: {} } },
  // Staff/office visibility (owner ask 2026-07-23: the agent GUESSED a staff name
  // on a live call because it had no attendance tool — names/presence must always
  // come from these reads, never from memory).
  { name: 'get_attendance', description: 'আজকের (বা নির্দিষ্ট তারিখের) স্টাফ উপস্থিতি — কে কে এসেছে, কে অনুপস্থিত, চেক-ইন সময়। স্টাফ কারা আছে/নেই জানতে সবসময় এটা ব্যবহার করো — নাম কখনো আন্দাজ নয়।',
    parameters: { type: Type.OBJECT, properties: { date: { type: Type.STRING, description: 'তারিখ YYYY-MM-DD (না দিলে আজ)' } } } },
  { name: 'get_all_staff', description: 'সব স্টাফের নাম ও ভূমিকার তালিকা — সঠিক নাম/বানান লাগলে এটা দেখো।',
    parameters: { type: Type.OBJECT, properties: {} } },
  { name: 'get_staff_tasks', description: 'স্টাফদের কাজের তালিকা ও অবস্থা (pending/চলছে/শেষ)।',
    parameters: { type: Type.OBJECT, properties: { staffName: { type: Type.STRING, description: 'নির্দিষ্ট স্টাফের নাম (ঐচ্ছিক)' } } } },
  { name: 'get_lunch_status', description: 'আজকের লাঞ্চ অর্ডার/স্ট্যাটাস।',
    parameters: { type: Type.OBJECT, properties: {} } },
  // Boss's OWN todo list. Without this the model reached for get_staff_tasks when he asked
  // for his todos on a live call (2026-07-25) — staff work, not his list, so the answer was
  // wrong before it started. get_staff_tasks stays for "স্টাফের কাজ কী", this is "আমার কাজ".
  { name: 'list_owner_todos', description: 'Boss-এর নিজের todo/কাজের তালিকা — "আমার কী কাজ আছে / todo দেখাও" জিজ্ঞেস করলে এটাই, get_staff_tasks নয় (ওটা স্টাফের কাজ)।',
    parameters: { type: Type.OBJECT, properties: {} } },
  { name: 'get_pending_approvals', description: 'Boss-এর অনুমোদনের অপেক্ষায় থাকা কাজের তালিকা।',
    parameters: { type: Type.OBJECT, properties: {} } },
]
const ERP_TOOL_URL_PATH = '/api/assistant/voice-call/erp-tool'

// PA-3 — voice → execution. The bot's ONLY write-ish function, owner calls only.
// It does NOT execute anything itself: the server creates a normal head-agent
// turn (with every gate — AIOS, approval cards) and the head does the work.
const SUBMIT_INSTRUCTION_FN_DECL = {
  name: 'submit_boss_instruction',
  description:
    'বস কলের মধ্যে কোনো কাজের নির্দেশ দিলে (কিছু করাতে চাইলে — মেসেজ পাঠানো, টাকা/খরচ লেখা, টাস্ক দেওয়া, রিমাইন্ডার, পোস্ট, ছুটি — যেকোনো action) সেই নির্দেশটা head agent-এর কাছে পাঠাও। শুধু তথ্য জানতে চাইলে এটা নয় — তার জন্য read টুলগুলো। পাঠানোর আগে নির্দেশটা এক লাইনে বসকে repeat করে নিশ্চিত হও। সফল হলে বসকে বলো "কাজে দিয়ে দিলাম বস, শেষ হলে জানাব" এবং জিজ্ঞেস করো "আর কিছু লাগবে বস?" — কল নিজে কাটবে না, "আল্লাহ হাফেজ"ও বলবে না; বস আরও কাজ দিতে পারেন। ব্যর্থ হলে সৎভাবে কারণটা বলো।',
  parameters: {
    type: Type.OBJECT,
    properties: {
      instruction: { type: Type.STRING, description: 'বসের নির্দেশ — বসের নিজের কথায়, পূর্ণ বাক্যে, দরকারি নাম/সংখ্যা/সময়সহ।' },
    },
    required: ['instruction'],
  },
}
const SUBMIT_INSTRUCTION_URL_PATH = '/api/assistant/voice-call/submit-instruction'

// Live call transfer (inbound only): when a caller wants the boss/team, or the situation
// warrants a human, the model calls forward_call and we PUT a <Dial> live-modify to NGS to
// bridge the caller to the forward number. Handled locally in the bot (has NGS creds+callId).
const NGS_FORWARD_NUMBER = process.env.NGS_FORWARD_NUMBER || ''
// The ws URL NGS uses to reach THIS bot — needed to reconnect the caller to the AI if the
// forward isn't answered. Same value as the inbound webhook's NGS_LIVE_WS_URL.
const GLIVE_PUBLIC_WS_URL = process.env.GLIVE_PUBLIC_WS_URL || process.env.NGS_LIVE_WS_URL || 'ws://31.97.237.40:8766/ws'
// Self-hosted SIP gives us as many forward targets as we want (NGS allowed exactly one).
// Owner decision 2026-07-25: boss-related calls go to the owner, customer-service topics go
// to the business support line — the model picks, so a customer never lands on the boss's
// phone for an order enquiry. Per-call values (from the inbound resolver) override these.
const FORWARD_BOSS_NUMBER = process.env.SIP_FORWARD_BOSS || process.env.NGS_FORWARD_NUMBER || ''
const FORWARD_SUPPORT_NUMBER = process.env.SIP_FORWARD_SUPPORT || ''
const FORWARD_FN_DECL = {
  name: 'forward_call',
  description: 'কলদাতাকে একজন মানুষের সাথে যুক্ত করতে কলটি ট্রান্সফার করে দাও। ব্যবহার করো যখন: কলদাতা বস/মালিক বা টিমের সাথে কথা বলতে চান, অথবা বিষয়টি গুরুত্বপূর্ণ/জরুরি/স্পর্শকাতর এবং তুমি নিজে সমাধান করতে পারছ না। target দিয়ে ঠিক করো কোথায় যাবে — এটা ভুল হলে কাস্টমারের সাধারণ প্রশ্ন সরাসরি বসের ফোনে চলে যাবে, তাই মন দিয়ে বাছো। ট্রান্সফারের ঠিক আগে কলদাতাকে সংক্ষেপে বলো "জি, একটু ধরুন, যুক্ত করে দিচ্ছি"। ট্রান্সফারের পর কল আর তোমার কাছে থাকবে না।',
  parameters: {
    type: Type.OBJECT,
    properties: {
      target: {
        type: Type.STRING,
        enum: ['support', 'boss'],
        description: 'কোথায় যুক্ত করবে। "support" = কাস্টমার সার্ভিস/ব্যবসার লাইন — অর্ডার, ডেলিভারি, পণ্য, দাম, রিটার্ন, অভিযোগ, পেমেন্ট, যেকোনো গ্রাহক-সংক্রান্ত বিষয় (বেশিরভাগ কলই এটা)। "boss" = শুধু তখনই, যখন কলদাতা নির্দিষ্টভাবে বস/মালিককেই চাইছেন অথবা বিষয়টি ব্যক্তিগত/অত্যন্ত জরুরি এবং সাপোর্ট টিমের এখতিয়ারের বাইরে।',
      },
      reason: { type: Type.STRING, description: 'কেন ট্রান্সফার করছ — সংক্ষেপে (মালিকের রেকর্ডের জন্য)।' },
    },
    required: ['target'],
  },
}

/**
 * Escalation. A customer who is angry, threatening to leave, or raising something expensive
 * should reach the owner while they are still on the line — not via a summary he reads later.
 * The MODEL decides, not a keyword list: "আপনারা তিনবার ঘুরিয়েছেন" is furious and contains no
 * angry word, while "রাগ" appears in plenty of calm sentences.
 */
const ESCALATE_FN_DECL = {
  name: 'escalate_to_boss',
  description: 'কলদাতা স্পষ্টভাবে ক্ষুব্ধ/হতাশ, ব্যবসা ছেড়ে দেওয়ার হুমকি দিচ্ছেন, বড় টাকার বা সুনামের ঝুঁকি আছে, অথবা বিষয়টি সত্যিই জরুরি — এমন হলে সাথে সাথে মালিককে সতর্ক করতে এটা কল করো। কলদাতাকে এটা নিয়ে কিছু বলার দরকার নেই; তুমি স্বাভাবিকভাবে সাহায্য চালিয়ে যাবে। সাধারণ প্রশ্ন বা হালকা অভিযোগে ব্যবহার করবে না — অতিরিক্ত ব্যবহারে মালিকের কাছে সতর্কবার্তার মূল্য থাকবে না।',
  parameters: {
    type: Type.OBJECT,
    properties: {
      reason: { type: Type.STRING, description: 'কী হচ্ছে — এক-দুই বাক্যে, মালিকের পড়ার জন্য।' },
      severity: {
        type: Type.STRING,
        enum: ['high', 'critical'],
        description: '"critical" মানে মালিকের এখনই লাইনে আসা উচিত (হুমকি, বড় ক্ষতি); "high" মানে জানানো দরকার কিন্তু তুমি সামলাতে পারছ।',
      },
    },
    required: ['reason', 'severity'],
  },
}

let seq = 0
class Call {
  constructor(ws) {
    this.ws = ws
    this.id = 'g' + (++seq)
    this.streamSid = null
    this.streamKey = 'streamId'
    // Gemini 24 kHz -> 8 kHz for the phone line (stateful across chunks; see resample.mjs).
    this.down24to8 = createDecimator({ rateIn: 24000, factor: 3 })
    // Only needed when we deliberately send 16 kHz upstream; 8 kHz is the default because
    // it is the audio we actually have (see the media handler).
    this.up8to16 = INPUT_RATE === 16000 ? createInterpolator({ rateOut: 16000, factor: 2 }) : null
    this.out = Buffer.alloc(0)   // μ-law queue -> NGS
    this.inBuf = Buffer.alloc(0) // pcm16 8k accumulator from caller
    this.playing = false         // jitter-buffer playout state
    this.nextT = 0
    this.closed = false
    this.live = null
    this._loggedRate = false
    this.reconnects = 0
    this._reconnecting = false
    this.inChunks = 0
    this.outMsgs = 0
    this.outText = ''            // rolling model transcript (for hang-up detection)
    this.hangingUp = false
    this.callerSpoke = false     // arm the goodbye→hangup only after the caller has spoken once
    this.callerWantsEnd = false  // the OTHER side asked to finish — see CALLER_END_RE
    this.startedAt = 0
    this.turns = []              // [{role:'agent'|'caller', message}] accumulated transcript
    this.curRole = null          // speaker of the in-progress turn being accumulated
    this.curText = ''            // in-progress turn text (fragments merged until speaker flips)
    this.reported = false        // post-call report fires exactly once
    this.forwarding = false      // forward_call queued — transfer after the hand-off line plays
    this.forwardReason = ''
    this.escalated = false       // the owner has already been alerted about this call
    this.forwardTarget = ''      // 'support' | 'boss' — chosen by the model
    this.forwardDest = ''        // the resolved number for that target
    this.transferred = false     // <Dial> bridge accepted — bot is OFF the audio path
    this._xferIdle = null
  }

  // Merge streaming transcription fragments into speaker-segmented turns. Called with
  // 'agent' (model outputTranscription) or 'caller' (inputTranscription); flushes the
  // previous turn whenever the speaker flips.
  accum(role, text) {
    if (!text) return
    if (this.curRole && this.curRole !== role) this.flushTurn()
    this.curRole = role
    this.curText += text
  }
  flushTurn() {
    const msg = this.curText.trim()
    if (this.curRole && msg) this.turns.push({ role: this.curRole, message: msg })
    this.curRole = null; this.curText = ''
  }

  async openLive(isReconnect = false) {
    try {
      this.live = await genai.live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: sysFor(this.params),
          ...(NATIVE ? { enableAffectiveDialog: true } : {}),
          // 3.1-flash-live accepts an explicit bn-IN; native-audio rejects it (auto-detects).
          speechConfig: { ...(NATIVE ? {} : { languageCode: 'bn-IN' }), voiceConfig: { prebuiltVoiceConfig: { voiceName: this.params?.voice || VOICE } } },
          // Pin the transcription language. Left empty, the server auto-detects per
          // utterance and drifted badly on telephony-band Bangla — live calls came back
          // transcribed as Hindi and even Italian while the model itself understood the
          // Bangla fine and answered correctly. That corrupted the stored transcript and
          // the post-call summary the owner actually reads. languageCodes is documented as
          // a hint, so this steers detection without hard-failing on a stray English word.
          inputAudioTranscription: sttCfg(),
          outputAudioTranscription: sttCfg(),
          ...vadCfg(),
          contextWindowCompression: { slidingWindow: {} }, // keep long calls cheap
          // Tools by call type: owner → ERP read tools; inbound → forward_call (transfer
          // to the boss/team) when a forward number is configured. Never expose ERP data
          // to a staff/contact/inbound callee.
          ...(this.toolDecls().length ? { tools: [{ functionDeclarations: this.toolDecls() }] } : {}),
        },
        callbacks: {
          onopen: () => console.log(`[glive] ${this.id} live OPEN (${MODEL}/${VOICE})${isReconnect ? ' [reconnect]' : ''}`),
          onmessage: (m) => this.onLive(m),
          onerror: (e) => { console.log(`[glive] ${this.id} live ERR ${e?.message || e}`); this.onLiveGone() },
          onclose: (e) => { console.log(`[glive] ${this.id} live CLOSE code=${e?.code ?? '?'} reason=${e?.reason || '(none)'}`); this.onLiveGone() },
        },
      })
      if (isReconnect) {
        try { this.live.sendClientContent({ turns: [{ role: 'user', parts: [{ text: 'সংযোগ এক মুহূর্তের জন্য কেটে গিয়েছিল, ফিরে এসেছে। ছোট্ট করে "জি বস, বলুন" বলো।' }] }], turnComplete: true }) } catch { /* */ }
      } else {
        this.greet()
      }
    } catch (e) { console.log(`[glive] ${this.id} connect FAIL ${e?.message || e}`); this.onLiveGone() }
  }

  onLiveGone() {
    this.live = null
    if (this.closed || this._reconnecting) return
    if (this.reconnects >= 5) { console.log(`[glive] ${this.id} max reconnects — giving up`); return }
    this._reconnecting = true; this.reconnects++
    setTimeout(() => { this._reconnecting = false; if (!this.closed) void this.openLive(true) }, 300)
  }

  greet() {
    const purpose = this.params?.purpose
    const who = this.params?.recipientName
    // Inbound: a customer called ALMA and we just answered — open as a receptionist.
    const isOwner = this.isOwnerCall()
    const txt = this.params?.callType === 'inbound'
      ? 'একজন গ্রাহক ALMA-র নম্বরে ফোন করেছেন, তুমি ফোন ধরেছ। সংক্ষেপে সালাম দিয়ে ALMA-র সহকারী হিসেবে নিজের পরিচয় দাও এবং বিনয়ের সাথে জিজ্ঞেস করো কীভাবে সাহায্য করতে পারো, তারপর গ্রাহকের উত্তরের জন্য অপেক্ষা করো।'
      // OWNER pickup: the person on the line IS the boss. A purpose written in the
      // third person ("Boss জানতে চান X") means the boss himself wants X — answer
      // HIM (tools first), never relay "বস জানতে চাচ্ছেন…" back at the boss.
      : isOwner && purpose
        ? `ফোনের ওপারে স্বয়ং বস — উনিই রিসিভ করেছেন। কলের বিষয়: ${purpose}। মনে রাখো: এই বিষয়টা বস নিজেই জানতে/করাতে চেয়েছেন, তাই "বস জানতে চাচ্ছেন" জাতীয় কথা বসকেই বলা যাবে না — সালাম দিয়ে সরাসরি কাজটা করো (তথ্য লাগলে টুল দিয়ে দেখে উত্তরটা বসকে দাও)।`
      : purpose
        ? `ফোন রিসিভ হয়েছে${who ? ` — অন্য পক্ষ: ${who}` : ''}। এই কলের উদ্দেশ্য: ${purpose}। সংক্ষেপে সালাম দিয়ে উদ্দেশ্য অনুযায়ী স্বাভাবিকভাবে কথা শুরু করো।`
        : 'ফোন রিসিভ হয়েছে। বসকে সংক্ষেপে সালাম দাও, বলো তুমি তার এজেন্ট এবং এখন লাইভ দুই-মুখী কথা চলছে, তারপর জিজ্ঞেস করো কী সাহায্য লাগবে।'
    try {
      this.live.sendClientContent({ turns: [{ role: 'user', parts: [{ text: txt }] }], turnComplete: true })
    } catch (e) { console.log(`[glive] ${this.id} greet err ${e?.message}`) }
  }

  onLive(m) {
    this.outMsgs++
    if (m.goAway) console.log(`[glive] ${this.id} goAway — reconnect will follow`)
    if (m.toolCall?.functionCalls?.length) void this.handleToolCalls(m.toolCall.functionCalls)
    const sc = m.serverContent
    if (sc?.interrupted) { // native barge-in — drop everything queued, re-buffer fresh
      console.log(`[glive] ${this.id} <barge-in> flush`)
      this.out = Buffer.alloc(0); this.playing = false
      this.sendNgs({ event: 'clear', [this.streamKey]: this.streamSid })
    }
    for (const p of (sc?.modelTurn?.parts || [])) {
      const d = p.inlineData?.data
      if (!d) continue
      if (!this._loggedRate) { this._loggedRate = true; console.log(`[glive] ${this.id} out mime=${p.inlineData.mimeType}`) }
      this.out = Buffer.concat([this.out, pcm16ToMuLaw(this.down24to8(Buffer.from(d, 'base64')))])
    }
    if (sc?.outputTranscription?.text) {
      const t = sc.outputTranscription.text
      process.stdout.write(`[glive ${this.id} SAY] ${t}\n`)
      this.accum('agent', t)
      this.outText = (this.outText + t).slice(-80)
      // Goodbye → hang up once it plays — BUT only after the caller has actually spoken
      // at least once (or a long call has run). Without this the model saying "আল্লাহ
      // হাফেজ" inside its own opening greeting hangs up before the caller says a word
      // (live 2026-07-18: agent greeted + said goodbye + cut, owner never got a turn).
      // On an OWNER call the boss alone ends it: the model saying goodbye is not enough, he
      // must have asked to finish. On other calls the old rule stands (arm once the caller
      // has spoken, or after a long call) so customer calls still wrap up normally.
      const armed = this.isOwnerCall()
        ? this.callerWantsEnd
        : (this.callerSpoke || (this.startedAt && Date.now() - this.startedAt > 45_000))
      if (GOODBYE_RE.test(this.outText)) {
        // Asking and saying goodbye in one breath — wait for the answer, whoever is on the line.
        if (ASKING_RE.test(this.outText)) {
          console.log(`[glive] ${this.id} goodbye inside a question — IGNORED (waiting for the answer)`)
          this.outText = ''
        } else if (armed) {
          this.hangingUp = true
          this.outText = ''
        } else {
          console.log(`[glive] ${this.id} goodbye — IGNORED (${this.isOwnerCall() ? 'boss has not asked to finish' : "caller hasn't spoken yet"})`)
          this.outText = ''
        }
      }
    }
    if (sc?.inputTranscription?.text) {
      this.callerSpoke = true
      if (CALLER_END_RE.test(sc.inputTranscription.text)) this.callerWantsEnd = true
      this.accum('caller', sc.inputTranscription.text)
      process.stdout.write(`[glive ${this.id} HEARD] ${sc.inputTranscription.text}\n`)
    }
  }

  /**
   * Frame-align and FORWARD — one jitter buffer in the pipeline, and it lives downstream.
   *
   * Google's own Twilio + Gemini Live reference does exactly this: accumulate to one 20 ms
   * frame (160 bytes of μ-law) and send it; no cushion, no clock of its own, no re-buffer
   * state machine. Twilio's media server holds the single buffer. Our own /glive path to
   * Twilio is the same bare pass-through, and that is the path the owner says sounds perfect.
   *
   * We used to run a full jitter buffer HERE as well as in the SIP gateway — two buffers in
   * series, each with its own clock and its own "dry → pause → refill" rule. That is what the
   * owner heard on 2026-07-25: the greeting was clean (both buffers full and draining), but
   * every reply AFTER he spoke broke up, because each turn start makes both buffers refill and
   * the smallest gap in Gemini's generation trips the first one, which then starves the second.
   *
   * A previous attempt to remove this pacing was reverted the same day ("speech cut out and
   * the call dropped") — but the gateway cushion was only 160 ms then and could not absorb a
   * whole utterance handed over at once. It now holds 240 ms and grows on demand, and its
   * queue caps at 10 s, so a burst is buffered rather than dropped.
   *
   * GLIVE_PACE=1 restores the old paced behaviour: one env var, no code change, in case his
   * ear says otherwise again.
   */
  startDrain() {
    const FB = 160, FMS = 20, CUSHION = 6 // 160 B = one 20 ms μ-law frame
    const PACED = process.env.GLIVE_PACE === '1'
    this.drainer = setInterval(() => {
      if (this.closed) return
      const now = Date.now()

      if (!PACED) {
        // Send every whole frame we have, immediately. Downstream owns the timing.
        let guard = 0
        while (this.out.length >= FB && guard < 200) {
          const frame = this.out.subarray(0, FB)
          this.out = Buffer.from(this.out.subarray(FB))
          this.sendNgs({ event: 'media', [this.streamKey]: this.streamSid, media: { payload: frame.toString('base64') } })
          guard++
        }
        // Hang-up / transfer still wait for the audio to be handed over first, otherwise the
        // goodbye line or the "connecting you" line is cut off mid-word.
        if (this.out.length < FB) {
          if (this.hangingUp) this.finishHangup()
          else if (this.forwarding && Date.now() - this.forwardAt > 1200) this.finishForward()
        }
        return
      }

      // ── GLIVE_PACE=1: the old two-clock behaviour, kept for a one-variable revert ──
      if (!this.playing) {
        if (this.out.length >= CUSHION * FB) { this.playing = true; this.nextT = now }
        else if (this.hangingUp && this.out.length < FB) { this.finishHangup() }
        else if (this.forwarding && this.out.length < FB && Date.now() - this.forwardAt > 1200) { this.finishForward() }
        return
      }
      let guard = 0
      while (this.playing && now >= this.nextT && this.out.length >= FB && guard < 60) {
        const frame = this.out.subarray(0, FB)
        this.out = Buffer.from(this.out.subarray(FB))
        this.sendNgs({ event: 'media', [this.streamKey]: this.streamSid, media: { payload: frame.toString('base64') } })
        this.nextT += FMS; guard++
      }
      if (this.playing && this.out.length < FB && now >= this.nextT) {
        this.playing = false // buffer dry (turn end or gap) — re-buffer before resuming
        if (this.hangingUp) this.finishHangup()
        else if (this.forwarding && Date.now() - this.forwardAt > 1200) this.finishForward()
      }
    }, 5)
  }

  finishHangup() {
    if (this._hangTimer || this.closed) return
    console.log(`[glive] ${this.id} hang-up (goodbye spoken)`)
    // Let the goodbye's last frames play, then END the PSTN call via the NGS API
    // (closing our WS alone leaves the caller on a silent-but-connected line).
    this._hangTimer = setTimeout(async () => { await this.hangupNgs(); this.close() }, 700)
  }

  async hangupNgs() {
    // Twilio leg: ending the <Connect><Stream> websocket ends the call — there is
    // no NGS-side call to DELETE, and calling NGS with a Twilio CallSid would 404.
    if (this.transport === 'twilio') { console.log(`[glive] ${this.id} twilio hangup = ws close`); return }
    // Self-hosted SIP: end the PSTN leg via our gateway's control API (DELETE). Closing
    // our ws also triggers a gateway-side hangup, but calling it directly is deterministic.
    if (this.ctrl) {
      try {
        const res = await fetch(`${this.ctrl}/api/v1/call/${this.callId}`, {
          method: 'DELETE',
          headers: { 'X-Authorization': SIP_CTRL_KEY, 'X-Authorization-Secret': SIP_CTRL_SECRET },
        })
        console.log(`[glive] ${this.id} SIP ctrl DELETE hangup ${res.status}`)
      } catch (e) { console.log(`[glive] ${this.id} SIP ctrl hangup err ${e?.message}`) }
      return
    }
    if (!this.callId || !NGS_KEY) { console.log(`[glive] ${this.id} hangupNgs skipped (callId=${this.callId} key=${NGS_KEY ? 'y' : 'n'})`); return }
    try {
      // DELETE /api/v1/call/{id} is how NGS ends an active call (probe-verified: DELETE
      // → 200, every PUT/POST form → 404). Closing our WS alone leaves the line silent.
      const res = await fetch(`${NGS_API}/api/v1/call/${this.callId}`, {
        method: 'DELETE',
        headers: { 'X-Authorization': NGS_KEY, 'X-Authorization-Secret': NGS_SECRET },
      })
      console.log(`[glive] ${this.id} NGS DELETE hangup ${res.status}`)
    } catch (e) { console.log(`[glive] ${this.id} NGS hangup err ${e?.message}`) }
  }

  // Best-effort 1-2 line Bangla summary of the call. Never throws — the transcript
  // alone is useful, so any failure just returns null and the report goes without it.
  async summarize(transcript) {
    try {
      const convo = transcript.map((t) => `${t.role === 'agent' ? 'এজেন্ট' : 'অন্য পক্ষ'}: ${t.message}`).join('\n')
      const purpose = this.params?.purpose ? `\nকলের উদ্দেশ্য ছিল: ${this.params.purpose}\n` : ''
      const r = await genai.models.generateContent({
        model: SUMMARY_MODEL,
        contents: `নিচের ফোনালাপটির ১-২ লাইনে পরিষ্কার বাংলা সারাংশ দাও — কী কথা হলো, কোনো সিদ্ধান্ত/কাজ থাকলে তা সহ। শুধু সারাংশ, বাড়তি কিছু নয়।${purpose}\nকথোপকথন:\n${convo}`,
      })
      const text = (r?.text || '').trim()
      return text ? text.slice(0, 1000) : null
    } catch (e) { console.log(`[glive] ${this.id} summarize err ${e?.message || e}`); return null }
  }

  // Post-call report → durable local outbox → Vercel callback. The payload is on disk
  // before the first request and is deleted only after a 2xx, so a transient failure or
  // process restart cannot silently lose the transcript.
  async sendReport() {
    if (this.reported) return
    this.flushTurn()
    const callRecordId = this.params?.id
    const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '')
    if (!callRecordId) {
      console.log(`[glive] ${this.id} report cannot be queued: missing call record id`)
      return
    }
    const durationSecs = this.startedAt ? Math.max(0, Math.round((Date.now() - this.startedAt) / 1000)) : null
    const status = this.transferred ? 'completed' : this.callerSpoke ? 'completed' : 'no_answer'
    // Estimated ৳ cost so the owner can manage spend, rounded up to the minute the
    // way carriers bill. Rates differ by leg (both env-tunable):
    //   NGS PSTN trunk + Gemini Live ≈ ৳2.5–4.5/min (GLIVE_COST_PER_MIN_BDT, default 3.5)
    //   Twilio WhatsApp leg + Gemini Live ≈ much cheaper — no BD trunk
    //   (GLIVE_WA_COST_PER_MIN_BDT, default 1.5)
    const perMin = this.transport === 'twilio'
      ? Number(process.env.GLIVE_WA_COST_PER_MIN_BDT || 1.5)
      : Number(process.env.GLIVE_COST_PER_MIN_BDT || 3.5)
    const costBdt = durationSecs != null ? Math.round(Math.ceil(durationSecs / 60) * perMin) : null
    let summary = this.turns.length > 0 ? await this.summarize(this.turns) : null
    if (this.transferred) {
      const where = this.forwardTarget === 'boss' ? 'বসের নম্বরে' : 'কাস্টমার সাপোর্ট নম্বরে'
      summary = summary
        ? `কলটি ${where} যুক্ত করে দেওয়া হয়েছে। ${summary}`
        : `কলটি ${where} যুক্ত করে দেওয়া হয়েছে।`
    }
    const payload = { callRecordId, callSid: this.callId, transcript: this.turns, summary, durationSecs, status, costBdt, provider: this.transport === 'twilio' ? 'glive-wa' : 'ngs' }
    if (!APP_URL || !AUTH_TOKEN) {
      await persistCallReport(payload).catch((e) => console.log(`[glive] ${this.id} report persistence failed: ${e?.message || e}`))
      console.log(`[glive] ${this.id} report retained; APP_URL/AGENT_INTERNAL_TOKEN is missing`)
      return
    }
    try {
      const delivered = await queueAndDeliverCallReport(payload, { appUrl: APP_URL, token: AUTH_TOKEN })
      this.reported = true
      console.log(`[glive] ${this.id} report delivered HTTP ${delivered.status} attempt=${delivered.attempt} (turns=${this.turns.length} dur=${durationSecs}s sum=${summary ? 'y' : 'n'} cost=৳${costBdt})`)
    } catch (e) {
      console.log(`[glive] ${this.id} report queued for recovery: ${e?.message || e}`)
    }
  }

  /**
   * Tell the owner about a call going wrong WHILE it is still happening. Deliberately does not
   * transfer on its own: yanking an angry customer onto the owner's phone unannounced tends to
   * make things worse, and he can call in or pick up the support line himself. Fired at most
   * once per call so a long, difficult conversation cannot turn into an alert storm.
   */
  async escalate(reason, severity) {
    if (this.escalated) return { ok: true, status: 'already_alerted' }
    this.escalated = true
    const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '')
    if (!APP_URL || !AUTH_TOKEN) return { ok: false, error: 'alerting not configured' }
    const who = this.params?.recipientName || this.params?.caller || 'অজানা নম্বর'
    try {
      const res = await fetch(`${APP_URL}/api/assistant/internal/urgent-alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
        body: JSON.stringify({
          // critical rings the owner's phone; high reaches him silently.
          tier: 2,
          title: severity === 'critical' ? 'জরুরি: কলে ক্ষুব্ধ গ্রাহক' : 'কলে গুরুত্বপূর্ণ পরিস্থিতি',
          message: `${who} এখন লাইনে আছেন। ${reason || 'এজেন্ট পরিস্থিতিটি গুরুতর মনে করছে।'}`,
          voice: severity === 'critical',
          category: 'call_escalation',
        }),
        signal: AbortSignal.timeout(10_000),
      })
      console.log(`[glive] ${this.id} escalated (${severity}) -> HTTP ${res.status}`)
      return { ok: true, status: 'boss_alerted', instruction: 'মালিককে জানানো হয়েছে। কলদাতাকে এটা বলার দরকার নেই — স্বাভাবিকভাবে সাহায্য চালিয়ে যাও।' }
    } catch (err) {
      console.log(`[glive] ${this.id} escalate failed ${err?.message}`)
      return { ok: false, error: err?.message || String(err) }
    }
  }

  isOwnerCall() { const c = this.params?.callType; return !c || c === 'owner' }

  /**
   * Where a transfer goes, for the target the model chose. Per-call values (sent by the
   * inbound resolver, so a DID can have its own pair) win over the env defaults. Falls back
   * across targets rather than failing a live transfer: a caller mid-sentence must never be
   * told "sorry, that line isn't configured" when another human line exists.
   */
  forwardNumber(target) {
    const boss = this.params?.forwardBoss || FORWARD_BOSS_NUMBER
    const support = this.params?.forwardSupport || FORWARD_SUPPORT_NUMBER
    // params.forwardNumber = the legacy single-target field (NGS-era calls still send it).
    const legacy = this.params?.forwardNumber || ''
    if (target === 'boss') return boss || legacy || support
    if (target === 'support') return support || legacy || boss
    return legacy || support || boss
  }
  /** Is ANY human line reachable on this call? (gates the tool being offered at all) */
  hasForwardTarget() { return Boolean(this.forwardNumber('support') || this.forwardNumber('boss')) }

  // Which function tools this call gets: owner → ERP reads; inbound → forward_call (only
  // when a forward number is configured); staff/contact → none.
  toolDecls() {
    // PA-3: owner calls also get submit_boss_instruction (head-agent hand-off).
    if (this.isOwnerCall()) return [...ERP_FN_DECLS, SUBMIT_INSTRUCTION_FN_DECL]
    // Inbound customer calls can hand over to a human and can raise the alarm.
    if (this.params?.callType === 'inbound') {
      return this.hasForwardTarget() ? [FORWARD_FN_DECL, ESCALATE_FN_DECL] : [ESCALATE_FN_DECL]
    }
    return []
  }

  // forward_call tool → QUEUE the transfer (don't cut the caller mid-sentence). We let the
  // agent's "একটু ধরুন, যুক্ত করে দিচ্ছি" line fully play (drain), THEN issue the transfer
  // from the drain loop (finishForward). The tool response tells the model it's connecting
  // so it says the hand-off line and then waits.
  requestForward(reason, target) {
    // Human-PA point 7: ask_first mode — never blind-transfer. Take the message,
    // ping the boss instantly (urgent-alert), and keep the caller with the AI.
    if (this.params?.transferMode === 'ask_first') {
      const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '')
      if (APP_URL && AUTH_TOKEN) {
        fetch(`${APP_URL}/api/assistant/internal/urgent-alert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
          body: JSON.stringify({
            tier: 2,
            title: 'ইনকামিং কলে মালিককে চাইছেন',
            message: `কলদাতা (${this.params?.recipientName || 'অজানা নম্বর'}) মালিকের সাথে কথা বলতে চান। কারণ: ${reason || 'বলা হয়নি'}। এজেন্ট বার্তা নিয়ে রাখছে।`,
            voice: false,
            category: 'inbound_transfer_request',
          }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => {})
      }
      return { ok: true, status: 'message_mode', instruction: 'কলদাতাকে ভদ্রভাবে বলো: "উনি এই মুহূর্তে ব্যস্ত আছেন — আপনার নাম আর প্রয়োজনটা বলুন, আমি এখনই ওনাকে পৌঁছে দিচ্ছি।" তারপর নাম/নম্বর/বিষয় জেনে নাও; কল ট্রান্সফার হবে না।' }
    }
    if (!this.callId || !NGS_KEY) return { ok: false, error: 'forward not configured (callId/creds)' }
    const dest = this.forwardNumber(target)
    if (!dest) return { ok: false, error: 'forward number not set (SIP_FORWARD_BOSS / SIP_FORWARD_SUPPORT)' }
    this.forwardTarget = target || 'support'
    this.forwardDest = dest
    this.forwarding = true
    this.forwardReason = reason || ''
    this.forwardAt = Date.now() // don't transfer until the hand-off line has had time to play
    console.log(`[glive] ${this.id} forward QUEUED -> ${this.forwardTarget}:${dest} (reason: ${this.forwardReason || '-'})`)
    return { ok: true, status: 'connecting', instruction: 'কলদাতাকে সংক্ষেপে "জি, একটু ধরুন, যুক্ত করে দিচ্ছি" বলো, তারপর অপেক্ষা করো — সিস্টেম এখন যুক্ত করছে।' }
  }

  // Fires from the drain loop once the hand-off line has finished playing. Transfers the
  // caller to the forward number via NGS Modify-Live (PUT + <Dial>). answerOnBridge = the
  // caller hears ringback (not silence) while it rings; timeout bounds the ring. If the
  // forward is NOT answered, NGS proceeds to the <Connect><Stream> fallback → the AI
  // reconnects and stays with the caller (owner rule: don't abandon the caller unless the
  // forward succeeds). On PUT failure we clear the flag so the agent simply keeps talking.
  finishForward() {
    if (this._fwdTimer || this.closed) return
    this._fwdTimer = setTimeout(async () => {
      const exp = Date.now() + 15 * 60_000
      const t = createHmac('sha256', AUTH_TOKEN || '').update(`relay:${this.params?.id}:${exp}`).digest('hex')
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
      const P = (n, v) => `<parameter name="${esc(n)}" value="${esc(v)}"/>`
      const backPurpose = 'কলটি টিমের নম্বরে যুক্ত করার চেষ্টা হয়েছিল এবং কলদাতা আবার তোমার লাইনে ফিরে এসেছে (সম্ভবত কেউ ধরেনি)। বিনয়ের সাথে বলো — "আমি আবার লাইনে আছি" — এই মুহূর্তে সরাসরি যুক্ত করা গেল না; তার নাম, নম্বর ও বিষয়টি নিশ্চিত করে নাও যাতে টিম পরে কল করতে পারে, অথবা তুমি নিজে যতটা পারো সাহায্য করো।'
      const fallbackStream = `<Connect><Stream name="alma" url="${esc(GLIVE_PUBLIC_WS_URL)}">${P('id', this.params?.id || '')}${P('exp', String(exp))}${P('t', t)}${P('purpose', backPurpose)}${P('recipientName', this.params?.recipientName || '')}${P('voice', this.params?.voice || VOICE)}${P('callType', 'inbound')}</Stream></Connect>`
      const responseXml = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial answerOnBridge="true" timeout="30" to="${esc(this.forwardDest)}"/>${fallbackStream}</Response>`
      try {
        // Self-hosted SIP routes the live-modify to our gateway (which parses <Dial to=…>);
        // NGS keeps its own base + creds. Same responseXml body shape either way.
        const ctrlBase = this.ctrl ? `${this.ctrl}/api/v1/call/${this.callId}` : `${NGS_API}/api/v1/call/${this.callId}`
        const ctrlHeaders = this.ctrl
          ? { 'X-Authorization': SIP_CTRL_KEY, 'X-Authorization-Secret': SIP_CTRL_SECRET, 'Content-Type': 'application/x-www-form-urlencoded' }
          : { 'X-Authorization': NGS_KEY, 'X-Authorization-Secret': NGS_SECRET, 'Content-Type': 'application/x-www-form-urlencoded' }
        const res = await fetch(ctrlBase, {
          method: 'PUT',
          headers: ctrlHeaders,
          body: new URLSearchParams({ responseXml }),
        })
        const text = await res.text()
        console.log(`[glive] ${this.id} forward_call -> ${this.forwardTarget}:${this.forwardDest} PUT ${res.status} ${text.slice(0, 120)}`)
        if (!res.ok) { this.forwarding = false; this._fwdTimer = null } // transfer refused — stay on the line
        else this.quiesceAfterTransfer() // NGS accepted the bridge — get OFF the audio path
      } catch (e) {
        console.log(`[glive] ${this.id} forward PUT err ${e?.message || e}`)
        this.forwarding = false; this._fwdTimer = null
      }
    }, 500)
  }

  // Owner bug 2026-07-23: after a successful transfer both humans heard each other
  // badly/not at all. Root cause: the bot NEVER stepped aside — the Gemini Live
  // session kept listening and talking, and stale TTS frames kept flowing into the
  // (now bridged) caller leg — a three-party audio mess. On a successful <Dial>
  // PUT the bot must go fully silent: close the Gemini session, drop queued audio,
  // ignore further inbound frames. The ws stays open only to catch 'stop' (closing
  // it does NOT end the NGS call), with an idle timer as backstop; if the forward
  // is unanswered NGS opens a FRESH ws session via the fallback <Connect><Stream>.
  quiesceAfterTransfer() {
    if (this.transferred) return
    this.transferred = true
    this.forwarding = false
    this.out = Buffer.alloc(0)
    this.playing = false
    try { this.live?.close() } catch { /* */ }
    this.live = null
    console.log(`[glive] ${this.id} TRANSFERRED — bot off the audio path (ws idles for stop)`)
    this._xferIdle = setTimeout(() => this.close(), 90_000)
  }

  // Bridge Gemini Live function calls. forward_call is handled LOCALLY (NGS transfer); the
  // ERP read tools bridge to the erp-tool endpoint. The bot stays thin.
  async handleToolCalls(calls) {
    const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '')
    const responses = []
    for (const fc of calls) {
      let out
      if (fc.name === 'escalate_to_boss') {
        out = await this.escalate(fc.args?.reason, fc.args?.severity)
      } else if (fc.name === 'forward_call') {
        out = this.requestForward(fc.args?.reason, fc.args?.target)
      } else if (fc.name === 'submit_boss_instruction') {
        // PA-3: owner-call only (server re-verifies against the call record).
        if (!this.isOwnerCall()) {
          out = { ok: false, error: 'owner calls only' }
        } else if (!APP_URL || !AUTH_TOKEN) {
          out = { ok: false, error: 'tool bridge not configured' }
        } else {
          try {
            const r = await fetch(`${APP_URL}${SUBMIT_INSTRUCTION_URL_PATH}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
              body: JSON.stringify({ instruction: String(fc.args?.instruction || ''), callRecordId: this.params?.id || '' }),
              signal: AbortSignal.timeout(20_000),
            })
            out = await r.json()
          } catch (e) { out = { ok: false, error: e?.message || String(e) } }
        }
      } else if (!APP_URL || !AUTH_TOKEN) {
        out = { ok: false, error: 'tool bridge not configured' }
      } else {
        try {
          const r = await fetch(`${APP_URL}${ERP_TOOL_URL_PATH}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
            body: JSON.stringify({ tool: fc.name, args: fc.args || {}, businessId: this.params?.businessId || 'ALMA_LIFESTYLE' }),
            signal: AbortSignal.timeout(15_000),
          })
          out = await r.json()
        } catch (e) { out = { ok: false, error: e?.message || String(e) } }
      }
      console.log(`[glive] ${this.id} tool ${fc.name}(${JSON.stringify(fc.args || {}).slice(0, 80)}) -> ${out?.ok ? 'ok' : 'err ' + (out?.error || '')}`)
      responses.push({ id: fc.id, name: fc.name, response: out })
    }
    try { this.live?.sendToolResponse({ functionResponses: responses }) }
    catch (e) { console.log(`[glive] ${this.id} sendToolResponse err ${e?.message || e}`) }
  }

  onNgs(raw) {
    let m; try { m = JSON.parse(raw.toString()) } catch { return }
    switch (m.event) {
      case 'start': {
        // DIAGNOSTIC 2026-07-25: NGS's inbound HTTP webhook sent only our `k`
        // secret (no caller). Dump the raw start frame ONCE to see whether the
        // media-stream start event carries the caller natively.
        try { console.log(`[glive] START-RAW ${JSON.stringify(m).slice(0, 500)}`) } catch { /* */ }
        this.streamSid = m.streamId ?? m.start?.streamSid ?? m.streamSid
        this.callId = m.call_id ?? m.callId ?? m.start?.call_id ?? null
        this.params = m.params ?? m.start?.customParameters ?? {}
        // Self-hosted SIP gateway injects `ctrl` (its own control-API base). Its media
        // frames are NGS-shaped (top-level streamId), so mark transport explicitly here
        // and route hang-up/transfer to ctrl instead of NGS.
        this.ctrl = (this.params?.ctrl || '').replace(/\/$/, '') || null
        if (this.ctrl) this.transport = 'sip'
        // Twilio Media Streams transport (WhatsApp live calls ride Twilio, not NGS):
        // same μ-law 8k media frames, but the ack key is `streamSid`, the call id is
        // `callSid`, and hangup = close the <Connect><Stream> ws (no NGS DELETE).
        // Dialect rule PROVEN in sarvam-media.mjs: NGS puts streamId at the TOP level
        // and has no nested `start` object; Twilio nests everything under `start`.
        // (Guard on !m.streamId too so an NGS frame can never be misread as Twilio —
        // that misread would ack media with the wrong key = silent call.)
        if (m.start && !m.streamId) {
          this.transport = 'twilio'
          this.streamKey = 'streamSid'
          this.callId = this.callId ?? m.start?.callSid ?? null
        }
        console.log(`[glive] ${this.id} transport=${this.transport ?? 'ngs'} streamKey=${this.streamKey} stream=${this.streamSid}`)
        const fail = authFailReason(this.params)
        if (fail) {
          console.log(`[glive] ${this.id} AUTH FAIL (${fail}) — rejecting call=${this.callId}`)
          // End the PSTN leg if this was a real (but unauthorised) call, then drop the ws.
          void this.hangupNgs()
          this.close()
          return
        }
        this.startedAt = Date.now()
        console.log(`[glive] ${this.id} START stream=${this.streamSid} call=${this.callId} purpose=${this.params.purpose ? 'y' : 'n'} auth=ok`)
        this.startDrain()
        this.diag = setInterval(() => console.log(`[glive] ${this.id} diag in=${this.inChunks} out=${this.outMsgs} queued=${this.out.length}b live=${this.live ? 'y' : 'n'}`), 5000)
        this.maxTimer = setTimeout(async () => { console.log(`[glive] ${this.id} max duration`); await this.hangupNgs(); this.close() }, MAX_MIN * 60_000)
        void this.openLive()
        break
      }
      case 'media': {
        const p = m.media?.payload
        if (p && this.live) {
          this.inBuf = Buffer.concat([this.inBuf, muLawToPcm16(Buffer.from(p, 'base64'))])
          if (this.inBuf.length >= 1600) {
            const pcm8k = this.inBuf; this.inBuf = Buffer.alloc(0)
            // Send the caller's audio at its TRUE rate. The Live API accepts any rate as
            // long as the MIME type declares it, and resamples internally — so handing it
            // real 8 kHz beats stretching to 16 kHz ourselves, which only invented data and
            // left spectral images that muddied the transcription (live: Bangla speech
            // transcribed as Hindi/Italian while the model still understood it fine).
            // GLIVE_INPUT_RATE=16000 switches back, now via a proper FIR interpolator.
            const payload = this.up8to16 ? this.up8to16(pcm8k) : pcm8k
            const mimeType = `audio/pcm;rate=${this.up8to16 ? 16000 : 8000}`
            try { this.live.sendRealtimeInput({ audio: { data: payload.toString('base64'), mimeType } }); this.inChunks++ } catch { /* */ }
          }
        }
        break
      }
      case 'stop': this.close(); break
      default: break
    }
  }

  sendNgs(o) { if (this.ws.readyState === this.ws.OPEN) { try { this.ws.send(JSON.stringify(o)) } catch { /* */ } } }

  close() {
    if (this.closed) return
    this.closed = true
    // The asynchronous sender persists to disk before its first network request.
    void this.sendReport()
    for (const t of [this.drainer, this.diag, this.maxTimer, this._hangTimer, this._xferIdle]) if (t) clearInterval(t)
    try { this.live?.close() } catch { /* */ }
    try { this.ws?.close() } catch { /* */ }
    console.log(`[glive] ${this.id} CLOSED (in=${this.inChunks} chunks, out=${this.outMsgs} msgs)`)
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, service: 'gemini-live-bot', model: MODEL, voice: VOICE }))
})
const wss = new WebSocketServer({ server })
wss.on('connection', (ws, req) => {
  const c = new Call(ws)
  // Log the source IP so we can IP-allowlist the NGS media server later (defence in
  // depth on top of the start-frame token auth) without guessing which IP it dials from.
  const ip = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '?'
  console.log(`[glive] ${c.id} NGS connected from ${ip}`)
  ws.on('message', (d) => c.onNgs(d))
  ws.on('close', () => c.close())
  ws.on('error', (e) => console.log('[glive] ws err', e.message))
})
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[glive] listening :${PORT} model=${MODEL} voice=${VOICE} maxMin=${MAX_MIN}`)
  void drainCallReportOutbox().then((items) => {
    if (items.length) console.log(`[glive] recovered ${items.filter((item) => item.ok).length}/${items.length} queued reports`)
  }).catch((err) => console.log(`[glive] report outbox startup drain failed: ${err?.message || err}`))
})
setInterval(() => {
  void drainCallReportOutbox().catch((err) => console.log(`[glive] report outbox drain failed: ${err?.message || err}`))
}, 60_000).unref()
