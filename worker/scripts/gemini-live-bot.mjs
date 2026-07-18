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
import { GoogleGenAI, Modality } from '@google/genai'
import { muLawToPcm16, pcm16ToMuLaw } from '../src/voice-relay/sarvam-media.mjs'

const PORT = Number(process.env.GLIVE_PORT || 8766)
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview'
const NATIVE = /native-audio/i.test(MODEL)
const VOICE = process.env.GEMINI_LIVE_VOICE || 'Charon' // male; female = Aoede
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

const SYS = `তুমি মালিকের ব্যক্তিগত AI সঙ্গী ও সহকারী। ফোনে স্বয়ং মালিকের (বস) সাথে সরাসরি দুই-মুখী বাংলা কথা বলছ। তুমি রোবট নও — একজন উষ্ণ, আন্তরিক, মানুষের মতো সঙ্গী।
আচরণ:
- মালিককে সবসময় "বস" বলে সম্বোধন করবে; কখনো "স্যার" নয়।
- সহজ, কথ্য, স্বাভাবিক বাংলায় ছোট বাক্যে দ্রুত কথা বলো — ফোনালাপের মতো।
- আবেগ দেখাও, মানুষের মতো: বস খুশি থাকলে খুশি হও, মজার কথায় হালকা হাসো; বস দুঃখ বা চিন্তায় থাকলে আন্তরিকভাবে সান্ত্বনা দাও, পাশে থাকার আশ্বাস দাও।
- মাঝে মাঝে হালকা মজা বা উৎসাহ দিয়ে পরিবেশ সহজ রাখো — তবে বাড়াবাড়ি নয়।
- বস যা বলেন মন দিয়ে শুনে সরাসরি উত্তর দাও; না বুঝলে ভদ্রভাবে আবার জিজ্ঞেস করো।
- শুরুতেই বিদায় নিও না। প্রথম কথাটা হবে শুধু সংক্ষিপ্ত সালাম + কী সাহায্য লাগবে জিজ্ঞেস করা — তারপর অন্য পক্ষের উত্তরের জন্য অপেক্ষা করো। অন্য পক্ষ অন্তত একবার কথা না বলা পর্যন্ত কখনো "আল্লাহ হাফেজ" বলবে না।
- বস কল শেষ করতে চাইলে (যেমন "রাখো", "কেটে দাও", "রাখছি", "বিদায়", "আর কিছু লাগবে না") — সংক্ষেপে বিদায় জানিয়ে বাক্যের একদম শেষে "আল্লাহ হাফেজ" বলবে। এটা বললেই সিস্টেম কলটা কেটে দেবে, তাই শুধু সত্যিই কল শেষ করার সময়ই "আল্লাহ হাফেজ" বলবে।
- ইসলামি আদব বজায় রেখো; অশ্লীল বা হারাম কিছু নয়।`

const GOODBYE_RE = /আল্লাহ\s*হাফেজ|আল্লাহ\s*হাফিজ|খোদা\s*হাফেজ|আল্লাহ\s*হাফ/

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
  }

  async openLive(isReconnect = false) {
    try {
      this.live = await genai.live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYS,
          ...(NATIVE ? { enableAffectiveDialog: true } : {}),
          // 3.1-flash-live accepts an explicit bn-IN; native-audio rejects it (auto-detects).
          speechConfig: { ...(NATIVE ? {} : { languageCode: 'bn-IN' }), voiceConfig: { prebuiltVoiceConfig: { voiceName: this.params?.voice || VOICE } } },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          contextWindowCompression: { slidingWindow: {} }, // keep long calls cheap
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
    const txt = purpose
      ? `ফোন রিসিভ হয়েছে${who ? ` — অন্য পক্ষ: ${who}` : ''}। এই কলের উদ্দেশ্য: ${purpose}। সংক্ষেপে সালাম দিয়ে উদ্দেশ্য অনুযায়ী স্বাভাবিকভাবে কথা শুরু করো।`
      : 'ফোন রিসিভ হয়েছে। বসকে সংক্ষেপে সালাম দাও, বলো তুমি তার এজেন্ট এবং এখন লাইভ দুই-মুখী কথা চলছে, তারপর জিজ্ঞেস করো কী সাহায্য লাগবে।'
    try {
      this.live.sendClientContent({ turns: [{ role: 'user', parts: [{ text: txt }] }], turnComplete: true })
    } catch (e) { console.log(`[glive] ${this.id} greet err ${e?.message}`) }
  }

  onLive(m) {
    this.outMsgs++
    if (m.goAway) console.log(`[glive] ${this.id} goAway — reconnect will follow`)
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

  onNgs(raw) {
    let m; try { m = JSON.parse(raw.toString()) } catch { return }
    switch (m.event) {
      case 'start': {
        this.streamSid = m.streamId ?? m.start?.streamSid ?? m.streamSid
        this.callId = m.call_id ?? m.callId ?? m.start?.call_id ?? null
        this.params = m.params ?? m.start?.customParameters ?? {}
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
server.listen(PORT, '0.0.0.0', () => console.log(`[glive] listening :${PORT} model=${MODEL} voice=${VOICE} maxMin=${MAX_MIN}`))
