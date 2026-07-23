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
import { GoogleGenAI, Modality, Type } from '@google/genai'
import { muLawToPcm16, pcm16ToMuLaw } from '../src/voice-relay/sarvam-media.mjs'
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
function up8to16(pcm8) { // PCM16 8k -> 16k (2x linear interp)
  const n = pcm8.length >> 1
  const out = Buffer.allocUnsafe(n * 4)
  let prev = n ? pcm8.readInt16LE(0) : 0
  for (let i = 0; i < n; i++) {
    const s = pcm8.readInt16LE(i * 2)
    out.writeInt16LE((prev + s) >> 1, i * 4); out.writeInt16LE(s, i * 4 + 2); prev = s
  }
  return out
}
function down24to8(pcm24) { // PCM16 24k -> 8k (÷3 averaging)
  const n = Math.floor((pcm24.length >> 1) / 3)
  const out = Buffer.allocUnsafe(n * 2)
  for (let i = 0; i < n; i++) {
    const a = pcm24.readInt16LE(i * 6), b = pcm24.readInt16LE(i * 6 + 2), c = pcm24.readInt16LE(i * 6 + 4)
    out.writeInt16LE(((a + b + c) / 3) | 0, i * 2)
  }
  return out
}

// Shared rules every call-type inherits (turn-taking, hang-up, adab).
const SYS_COMMON = `- সহজ, কথ্য, স্বাভাবিক বাংলায় ছোট বাক্যে দ্রুত কথা বলো — ফোনালাপের মতো।
- শুরুতেই বিদায় নিও না। প্রথম কথাটা হবে শুধু সংক্ষিপ্ত সালাম/পরিচয় + মূল কথা — তারপর অন্য পক্ষের উত্তরের জন্য অপেক্ষা করো। অন্য পক্ষ অন্তত একবার কথা না বলা পর্যন্ত কখনো "আল্লাহ হাফেজ" বলবে না।
- কল শেষ করার সময় (অন্য পক্ষ "রাখো/কেটে দাও/বিদায়/আর কিছু লাগবে না" বললে বা কাজ শেষ হলে) — সংক্ষেপে বিদায় জানিয়ে বাক্যের একদম শেষে "আল্লাহ হাফেজ" বলবে। এটা বললেই সিস্টেম কলটা কেটে দেবে, তাই শুধু সত্যিই শেষ করার সময়ই বলবে।
- ইসলামি আদব বজায় রেখো; অশ্লীল বা হারাম কিছু নয়।`

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
- কলদাতা যদি সরাসরি বস/মালিক বা টিমের সাথে কথা বলতে চান, অথবা বিষয়টি গুরুত্বপূর্ণ/জরুরি/স্পর্শকাতর মনে হয় এবং তুমি নিজে সমাধান করতে পারছ না — তখন কলটা টিমের নম্বরে যুক্ত করে দাও। এর জন্য অবশ্যই forward_call ফাংশনটা কল করতে হবে — শুধু মুখে "যুক্ত করে দিচ্ছি" বললে ট্রান্সফার হবে না, ফাংশন কল না করলে সিস্টেম যুক্ত করতে পারবে না। সংক্ষেপে "জি, একটু ধরুন, যুক্ত করে দিচ্ছি" বলেই সাথে সাথে forward_call কল করবে। অকারণে বারবার ট্রান্সফার করবে না — আগে নিজে সাহায্যের চেষ্টা করবে।
- কাজ শেষ হলে ভদ্রভাবে ধন্যবাদ দিয়ে বিদায় নাও। কল শেষে মালিক গ্রাহকের দরকারের একটা সারাংশ পাবেন।
${SYS_COMMON}`

function sysFor(params) {
  const who = params?.recipientName || ''
  const purpose = params?.purpose || ''
  switch (params?.callType) {
    case 'staff': return sysStaff(who, purpose)
    case 'contact': return sysContact(who, purpose)
    case 'inbound': return SYS_INBOUND
    default: return SYS_OWNER
  }
}

const GOODBYE_RE = /আল্লাহ\s*হাফেজ|আল্লাহ\s*হাফিজ|খোদা\s*হাফেজ|আল্লাহ\s*হাফ/

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
  { name: 'get_pending_approvals', description: 'Boss-এর অনুমোদনের অপেক্ষায় থাকা কাজের তালিকা।',
    parameters: { type: Type.OBJECT, properties: {} } },
]
const ERP_TOOL_URL_PATH = '/api/assistant/voice-call/erp-tool'

// Live call transfer (inbound only): when a caller wants the boss/team, or the situation
// warrants a human, the model calls forward_call and we PUT a <Dial> live-modify to NGS to
// bridge the caller to the forward number. Handled locally in the bot (has NGS creds+callId).
const NGS_FORWARD_NUMBER = process.env.NGS_FORWARD_NUMBER || ''
// The ws URL NGS uses to reach THIS bot — needed to reconnect the caller to the AI if the
// forward isn't answered. Same value as the inbound webhook's NGS_LIVE_WS_URL.
const GLIVE_PUBLIC_WS_URL = process.env.GLIVE_PUBLIC_WS_URL || process.env.NGS_LIVE_WS_URL || 'ws://31.97.237.40:8766/ws'
const FORWARD_FN_DECL = {
  name: 'forward_call',
  description: 'কলদাতাকে সরাসরি বস/মালিক বা টিমের সাথে যুক্ত করতে কলটি ট্রান্সফার করে দাও। ব্যবহার করো যখন: কলদাতা বলেন তিনি বস/মালিক/টিমের সাথে কথা বলতে চান, অথবা বিষয়টি গুরুত্বপূর্ণ/জরুরি/স্পর্শকাতর এবং তুমি নিজে সমাধান করতে পারছ না। ট্রান্সফারের ঠিক আগে কলদাতাকে সংক্ষেপে বলো "জি, একটু ধরুন, যুক্ত করে দিচ্ছি"। ট্রান্সফারের পর কল আর তোমার কাছে থাকবে না।',
  parameters: { type: Type.OBJECT, properties: { reason: { type: Type.STRING, description: 'কেন ট্রান্সফার করছ — সংক্ষেপে (মালিকের রেকর্ডের জন্য)।' } } },
}

let seq = 0
class Call {
  constructor(ws) {
    this.ws = ws
    this.id = 'g' + (++seq)
    this.streamSid = null
    this.streamKey = 'streamId'
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
    this.startedAt = 0
    this.turns = []              // [{role:'agent'|'caller', message}] accumulated transcript
    this.curRole = null          // speaker of the in-progress turn being accumulated
    this.curText = ''            // in-progress turn text (fragments merged until speaker flips)
    this.reported = false        // post-call report fires exactly once
    this.forwarding = false      // forward_call queued — transfer after the hand-off line plays
    this.forwardReason = ''
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
          inputAudioTranscription: {},
          outputAudioTranscription: {},
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
      this.out = Buffer.concat([this.out, pcm16ToMuLaw(down24to8(Buffer.from(d, 'base64')))])
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
      const armed = this.callerSpoke || (this.startedAt && Date.now() - this.startedAt > 45_000)
      if (armed && GOODBYE_RE.test(this.outText)) { this.hangingUp = true; this.outText = '' }
      else if (!armed && GOODBYE_RE.test(this.outText)) {
        console.log(`[glive] ${this.id} goodbye in opening — IGNORED (caller hasn't spoken yet)`)
        this.outText = ''
      }
    }
    if (sc?.inputTranscription?.text) {
      this.callerSpoke = true
      this.accum('caller', sc.inputTranscription.text)
      process.stdout.write(`[glive ${this.id} HEARD] ${sc.inputTranscription.text}\n`)
    }
  }

  // Jitter-buffer playout: wait for a small cushion, then play at real time; if the
  // buffer runs dry mid-stream, PAUSE and re-buffer (prevents "kete kete" cuts) rather
  // than stutter. Clock-scheduled (nextT) so a busy event loop just catches up.
  startDrain() {
    const FB = 160, FMS = 20, CUSHION = 6 // ~120 ms of audio before (re)starting playout
    this.drainer = setInterval(() => {
      if (this.closed) return
      const now = Date.now()
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
    const status = this.callerSpoke ? 'completed' : 'no_answer'
    // Estimated ৳ cost so the owner can manage spend, rounded up to the minute the
    // way carriers bill. Rates differ by leg (both env-tunable):
    //   NGS PSTN trunk + Gemini Live ≈ ৳2.5–4.5/min (GLIVE_COST_PER_MIN_BDT, default 3.5)
    //   Twilio WhatsApp leg + Gemini Live ≈ much cheaper — no BD trunk
    //   (GLIVE_WA_COST_PER_MIN_BDT, default 1.5)
    const perMin = this.transport === 'twilio'
      ? Number(process.env.GLIVE_WA_COST_PER_MIN_BDT || 1.5)
      : Number(process.env.GLIVE_COST_PER_MIN_BDT || 3.5)
    const costBdt = durationSecs != null ? Math.round(Math.ceil(durationSecs / 60) * perMin) : null
    const summary = this.turns.length > 0 ? await this.summarize(this.turns) : null
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

  isOwnerCall() { const c = this.params?.callType; return !c || c === 'owner' }

  // Which function tools this call gets: owner → ERP reads; inbound → forward_call (only
  // when a forward number is configured); staff/contact → none.
  toolDecls() {
    if (this.isOwnerCall()) return ERP_FN_DECLS
    if (this.params?.callType === 'inbound' && NGS_FORWARD_NUMBER) return [FORWARD_FN_DECL]
    return []
  }

  // forward_call tool → QUEUE the transfer (don't cut the caller mid-sentence). We let the
  // agent's "একটু ধরুন, যুক্ত করে দিচ্ছি" line fully play (drain), THEN issue the transfer
  // from the drain loop (finishForward). The tool response tells the model it's connecting
  // so it says the hand-off line and then waits.
  requestForward(reason) {
    if (!this.callId || !NGS_KEY) return { ok: false, error: 'forward not configured (callId/creds)' }
    if (!NGS_FORWARD_NUMBER) return { ok: false, error: 'NGS_FORWARD_NUMBER not set' }
    this.forwarding = true
    this.forwardReason = reason || ''
    this.forwardAt = Date.now() // don't transfer until the hand-off line has had time to play
    console.log(`[glive] ${this.id} forward QUEUED -> ${NGS_FORWARD_NUMBER} (reason: ${this.forwardReason || '-'})`)
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
      const responseXml = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial answerOnBridge="true" timeout="30" to="${esc(NGS_FORWARD_NUMBER)}"/>${fallbackStream}</Response>`
      try {
        const res = await fetch(`${NGS_API}/api/v1/call/${this.callId}`, {
          method: 'PUT',
          headers: { 'X-Authorization': NGS_KEY, 'X-Authorization-Secret': NGS_SECRET, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ responseXml }),
        })
        const text = await res.text()
        console.log(`[glive] ${this.id} forward_call -> ${NGS_FORWARD_NUMBER} PUT ${res.status} ${text.slice(0, 120)}`)
        if (!res.ok) { this.forwarding = false; this._fwdTimer = null } // transfer refused — stay on the line
      } catch (e) {
        console.log(`[glive] ${this.id} forward PUT err ${e?.message || e}`)
        this.forwarding = false; this._fwdTimer = null
      }
    }, 500)
  }

  // Bridge Gemini Live function calls. forward_call is handled LOCALLY (NGS transfer); the
  // ERP read tools bridge to the erp-tool endpoint. The bot stays thin.
  async handleToolCalls(calls) {
    const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '')
    const responses = []
    for (const fc of calls) {
      let out
      if (fc.name === 'forward_call') {
        out = this.requestForward(fc.args?.reason)
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
        this.streamSid = m.streamId ?? m.start?.streamSid ?? m.streamSid
        this.callId = m.call_id ?? m.callId ?? m.start?.call_id ?? null
        this.params = m.params ?? m.start?.customParameters ?? {}
        // Twilio Media Streams transport (WhatsApp live calls ride Twilio, not NGS):
        // same μ-law 8k media frames, but the ack key is `streamSid`, the call id is
        // `callSid`, and hangup = close the <Connect><Stream> ws (no NGS DELETE).
        if (m.start?.streamSid) {
          this.transport = 'twilio'
          this.streamKey = 'streamSid'
          this.callId = this.callId ?? m.start?.callSid ?? null
        }
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
            const pcm16k = up8to16(this.inBuf); this.inBuf = Buffer.alloc(0)
            try { this.live.sendRealtimeInput({ audio: { data: pcm16k.toString('base64'), mimeType: 'audio/pcm;rate=16000' } }); this.inChunks++ } catch { /* */ }
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
    for (const t of [this.drainer, this.diag, this.maxTimer, this._hangTimer]) if (t) clearInterval(t)
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
