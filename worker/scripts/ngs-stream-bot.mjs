/**
 * NextGenSwitch <stream> two-way bot — standalone test server (port 8766).
 * Ears = Sarvam saaras STT, brain = Gemini, voice = Sarvam Bulbul (anushka).
 *
 * NGS's stream frame format is undocumented, so this server:
 *   - records the first frames of every connection (GET /frames to inspect)
 *   - speaks Twilio-Media-Streams-style JSON if that's what arrives
 *     (event: start/media/stop, base64 mu-law 8k) — same dialect our /media uses
 *   - falls back to RAW binary audio frames (PCM16/mu-law guessed by size)
 *
 * Run on the VPS:  pm2 start scripts/ngs-stream-bot.mjs --name ngs-stream-bot
 */
import http from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { GoogleGenAI } from '@google/genai'
import { muLawToPcm16, pcm16ToMuLaw, wavToPcm16 } from '../src/voice-relay/sarvam-media.mjs'

const PORT = Number(process.env.NGS_BOT_PORT || 8766)
const MODEL = process.env.VOICE_RELAY_MODEL_ID || 'gemini-3.5-flash'
const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

const frameLog = [] // rolling per-connection first-frames, for remote inspection
function logFrame(connId, msg) {
  frameLog.push({ t: new Date().toISOString(), c: connId, m: msg })
  if (frameLog.length > 60) frameLog.shift()
  console.log(`[frames] ${connId}: ${msg}`)
}

function pcm16ToWav(pcm, sampleRate = 8000) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

const SYS =
  'তুমি মালিকের ব্যক্তিগত AI সহকারী, ফোনে স্বয়ং মালিকের (বস) সাথে কথা বলছ — এটা বাংলাদেশি নম্বরের দুই-মুখী টেস্ট কল। ' +
  'সবসময় "বস" বলে সম্বোধন করবে, কখনো "স্যার" নয়। সহজ কথ্য বাংলায় ১-২ বাক্যে উত্তর দাও, markdown/emoji নয়। ' +
  'বস যা জিজ্ঞেস করেন তার সরাসরি উত্তর দাও; না বুঝলে "দুঃখিত বস, আরেকবার বলবেন?" বলো।'

async function tts(text) {
  const r = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: { 'api-subscription-key': process.env.SARVAM_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.slice(0, 400), target_language_code: 'bn-IN', model: 'bulbul:v2', speaker: 'anushka', speech_sample_rate: 8000 }),
  })
  const j = await r.json()
  if (!j.audios?.[0]) throw new Error('tts fail ' + JSON.stringify(j).slice(0, 120))
  return wavToPcm16(Buffer.from(j.audios[0], 'base64')) // PCM16 8k
}

let connSeq = 0
class Session {
  constructor(ws) {
    this.ws = ws
    this.id = 'c' + (++connSeq)
    this.mode = null // 'twilio' | 'raw'
    this.rawEnc = null // 'pcm16' | 'mulaw'
    this.streamSid = null
    this.history = []
    this.speaking = false
    this.frames = 0
    this.buf = null
    this.greeted = false
    this.openStt()
    // If nothing arrives quickly (or raw mode never says hello), still greet.
    this.greetTimer = setTimeout(() => this.greet(), 2500)
    console.log(`[bot] ${this.id} connected`)
  }

  openStt() {
    const qs = new URLSearchParams({ 'language-code': 'bn-IN', model: 'saaras:v3', sample_rate: '8000', vad_signals: 'true' })
    this.stt = new WebSocket(`wss://api.sarvam.ai/speech-to-text/ws?${qs}`, {
      headers: { 'Api-Subscription-Key': process.env.SARVAM_API_KEY || '' },
    })
    this.stt.on('open', () => { this.sttReady = true; console.log(`[bot] ${this.id} STT open`) })
    this.stt.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()) } catch { return }
      if (m.type === 'data') {
        const text = String(m.data?.transcript ?? '').trim()
        if (text) { console.log(`[bot] ${this.id} heard: "${text.slice(0, 80)}"`); void this.respond(text) }
      }
    })
    this.stt.on('error', (e) => console.log(`[bot] ${this.id} stt err ${e.message}`))
  }

  feedStt(pcm) {
    if (!this.sttReady || this.speaking) return
    this.buf = this.buf ? Buffer.concat([this.buf, pcm]) : pcm
    if (this.buf.length >= 1600) { // 100ms @8k pcm16
      const wav = pcm16ToWav(this.buf)
      this.buf = null
      try { this.stt.send(JSON.stringify({ audio: { data: wav.toString('base64'), sample_rate: '8000', encoding: 'audio/wav' } })) } catch { /* */ }
    }
  }

  async respond(userText) {
    this.history.push({ role: 'user', text: userText })
    let reply = ''
    try {
      const res = await genai.models.generateContent({
        model: MODEL,
        contents: this.history.slice(-12).map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.text }] })),
        config: { systemInstruction: SYS, temperature: 0.5, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } },
      })
      reply = (res.text ?? '').trim()
    } catch (e) {
      console.log(`[bot] ${this.id} gemini err ${e.message}`)
      reply = 'দুঃখিত বস, একটু সমস্যা হলো — আবার বলবেন?'
    }
    if (!reply) return
    this.history.push({ role: 'assistant', text: reply })
    console.log(`[bot] ${this.id} say: "${reply.slice(0, 80)}"`)
    await this.say(reply)
  }

  async greet() {
    if (this.greeted) return
    this.greeted = true
    await this.say('আসসালামু আলাইকুম বস। আমি আপনার এজেন্ট, বাংলাদেশি নম্বরে এখন দুই-মুখী কথা চলছে। আমাকে যেকোনো কিছু জিজ্ঞেস করুন।').catch((e) => console.log('[bot] greet err', e.message))
  }

  async say(text) {
    let pcm
    try { pcm = await tts(text) } catch (e) { console.log(`[bot] ${this.id} tts err ${e.message}`); return }
    this.speaking = true
    try {
      if (this.mode === 'twilio') {
        const mu = pcm16ToMuLaw(pcm)
        for (let off = 0; off < mu.length; off += 160) {
          let f = mu.subarray(off, off + 160)
          if (f.length < 160) f = Buffer.concat([f, Buffer.alloc(160 - f.length, 0xff)])
          this.send({ event: 'media', streamId: this.streamSid, media: { payload: f.toString('base64') } })
        }
        this.send({ event: 'mark', streamId: this.streamSid, mark: { name: 'm' + Date.now() } })
        // no mark echo guarantee from NGS — release the floor on a duration timer
        setTimeout(() => { this.speaking = false }, (mu.length / 8000) * 1000 + 400)
      } else {
        // raw binary mode — send in the encoding we detected, paced 20ms
        const out = this.rawEnc === 'mulaw' ? pcm16ToMuLaw(pcm) : pcm
        const frame = this.rawEnc === 'mulaw' ? 160 : 320
        let off = 0
        const timer = setInterval(() => {
          if (off >= out.length || this.ws.readyState !== this.ws.OPEN) { clearInterval(timer); this.speaking = false; return }
          this.ws.send(out.subarray(off, off + frame))
          off += frame
        }, 20)
      }
    } catch (e) {
      console.log(`[bot] ${this.id} say err ${e.message}`)
      this.speaking = false
    }
  }

  send(obj) { if (this.ws.readyState === this.ws.OPEN) { try { this.ws.send(JSON.stringify(obj)) } catch { /* */ } } }

  onMessage(data, isBinary) {
    this.frames++
    if (this.frames <= 12) {
      logFrame(this.id, isBinary ? `BINARY len=${data.length}` : `TEXT ${data.toString().slice(0, 260)}`)
    }
    if (isBinary) {
      if (!this.mode) {
        this.mode = 'raw'
        this.rawEnc = data.length % 320 === 0 ? 'pcm16' : 'mulaw'
        console.log(`[bot] ${this.id} mode=raw enc=${this.rawEnc} (first len=${data.length})`)
        clearTimeout(this.greetTimer)
        void this.greet()
      }
      const pcm = this.rawEnc === 'mulaw' ? muLawToPcm16(data) : data
      this.feedStt(pcm)
      return
    }
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }
    if (!this.mode && msg.event) {
      this.mode = 'twilio'
      console.log(`[bot] ${this.id} mode=twilio`)
    }
    switch (msg.event) {
      case 'start':
        this.streamSid = msg.streamId ?? msg.start?.streamSid ?? msg.streamSid ?? null
        clearTimeout(this.greetTimer)
        void this.greet()
        break
      case 'media':
        if (msg.media?.payload) this.feedStt(muLawToPcm16(Buffer.from(msg.media.payload, 'base64')))
        break
      case 'stop':
        this.close()
        break
      default:
        break
    }
  }

  close() {
    try { this.stt?.close() } catch { /* */ }
    try { this.ws?.close() } catch { /* */ }
    console.log(`[bot] ${this.id} closed after ${this.frames} frames`)
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/frames') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(frameLog, null, 1))
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, service: 'ngs-stream-bot' }))
})
const wss = new WebSocketServer({ server })
wss.on('connection', (ws) => {
  const s = new Session(ws)
  ws.on('message', (d, b) => s.onMessage(d, b))
  ws.on('close', () => s.close())
  ws.on('error', (e) => console.log('[bot] ws err', e.message))
})
server.listen(PORT, '0.0.0.0', () => console.log(`[bot] listening :${PORT}`))
