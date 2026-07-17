/**
 * Two-way Bangla phone call over Twilio Media Streams — brain = Gemini, ears =
 * Sarvam streaming STT (saaras:v3), voice = Sarvam Bulbul TTS. This replaces the
 * ConversationRelay path (Google/Deepgram only) whose Bangla telephony STT mangled
 * even the owner's hang-up words (live 2026-07-18). Sarvam transcribed the SAME
 * recording near-perfectly, so the whole audio path is ours now.
 *
 * Flow per call:
 *   Twilio  --(μ-law 8k frames)-->  us  --(PCM16 8k)-->  Sarvam STT ws
 *   Sarvam STT --(transcript + VAD START/END)--> us
 *   us --(text)--> Gemini --(Bangla reply)--> Bulbul TTS --(WAV 8k)-->
 *   us --(μ-law 8k frames, paced)--> Twilio        (barge-in clears the queue)
 *
 * Reuses the deterministic hang-up (endSignalFromCaller / isHangupConfirmation) and
 * the mis-heard guard from transcript-guard.mjs, plus DTMF-to-hang-up.
 */
import { WebSocket, WebSocketServer } from 'ws'
import { GoogleGenAI } from '@google/genai'
import {
  isUnintelligibleTranscript,
  endSignalFromCaller,
  isHangupConfirmation,
} from './transcript-guard.mjs'

const SARVAM_STT_URL = 'wss://api.sarvam.ai/speech-to-text/ws'
const SARVAM_TTS_URL = 'https://api.sarvam.ai/text-to-speech'
const MODEL = () => process.env.VOICE_RELAY_MODEL_ID || 'gemini-3.5-flash'
const STT_MODEL = () => process.env.SARVAM_STT_MODEL || 'saaras:v3'
const TTS_MODEL = () => process.env.SARVAM_TTS_MODEL || 'bulbul:v2'
const TTS_SPEAKER = () => process.env.SARVAM_TTS_SPEAKER || 'anushka' // female — owner-confirmed clear sound + pace
const MAX_CALL_MIN = () => Number(process.env.VOICE_CALL_MAX_MINUTES) || 10
const END_MARKER = '[[END_CALL]]'

// ── G.711 μ-law <-> PCM16 (Twilio media is 8 kHz mono μ-law) ─────────────────
const BIAS = 0x84
const CLIP = 32635
function muLawDecodeSample(u) {
  u = ~u & 0xff
  const sign = u & 0x80
  const exponent = (u >> 4) & 0x07
  const mantissa = u & 0x0f
  let sample = ((mantissa << 3) + BIAS) << exponent
  sample -= BIAS
  return sign ? -sample : sample
}
function muLawEncodeSample(sample) {
  let sign = (sample >> 8) & 0x80
  if (sign) sample = -sample
  if (sample > CLIP) sample = CLIP
  sample += BIAS
  let exponent = 7
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f
  return ~(sign | (exponent << 4) | mantissa) & 0xff
}
function muLawToPcm16(mu) {
  const out = Buffer.allocUnsafe(mu.length * 2)
  for (let i = 0; i < mu.length; i++) out.writeInt16LE(muLawDecodeSample(mu[i]), i * 2)
  return out
}
function pcm16ToMuLaw(pcm) {
  const n = pcm.length >> 1
  const out = Buffer.allocUnsafe(n)
  for (let i = 0; i < n; i++) out[i] = muLawEncodeSample(pcm.readInt16LE(i * 2))
  return out
}
/** Wrap raw PCM16 mono samples in a minimal WAV container (Sarvam STT wants audio/wav). */
function pcm16ToWav(pcm, sampleRate = 8000) {
  const h = Buffer.alloc(44)
  const byteRate = sampleRate * 2
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(byteRate, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

/** Strip a RIFF/WAVE header if present, returning raw PCM16 samples. */
function wavToPcm16(buf) {
  if (buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF') {
    // find the 'data' chunk
    let off = 12
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4)
      const size = buf.readUInt32LE(off + 4)
      if (id === 'data') return buf.subarray(off + 8, off + 8 + size)
      off += 8 + size + (size & 1)
    }
    return buf.subarray(44)
  }
  return buf
}

function buildPrompt({ purpose, recipientName }) {
  const owner = /\b(boss|বস|maruf|মারুফ|মালিক)\b/i.test(String(recipientName ?? ''))
  return (
    `তুমি মালিকের ব্যক্তিগত সহকারী, ফোনে ${recipientName ? recipientName + ' এর' : 'একজনের'} ` +
    `সাথে কথা বলছ। উদ্দেশ্য: ${purpose || 'মালিকের বার্তা পৌঁছে দেওয়া'}।\n` +
    (owner ? `- অন্য পক্ষ স্বয়ং মালিক। সবসময় "বস" বলে সম্বোধন করবে — কখনো "স্যার" নয়।\n` : '') +
    `- সহজ, উষ্ণ, কথ্য বাংলায় ছোট উত্তর দাও (১-২ বাক্য)। markdown/emoji/তালিকা নয়।\n` +
    `- বস যা জিজ্ঞেস করেন ঠিক তারই উত্তর দাও — প্রসঙ্গের বাইরে যেও না।\n` +
    `- সত্যিই না বুঝলে একবার "দুঃখিত বস, একটু বুঝিয়ে বলবেন?" জিজ্ঞেস করো; নইলে সরাসরি উত্তর দাও।\n` +
    `- বস কথা শেষ করতে চাইলে (যেমন "রাখো", "কেটে দাও", "আর কিছু লাগবে না", "রাখছি", "শেষ করো") — ` +
    `ছোট্ট করে বিদায় বলো এবং বাক্যের একদম শেষে ${END_MARKER} লেখো (এটা উচ্চারিত হবে না; সিস্টেম কল কেটে দেবে)। ` +
    `**কখনো বলবে না যে তুমি কল কাটতে পারো না — তুমি পারো।** তবে সন্দেহ থাকলে আগে "তাহলে কি রাখব বস?" জিজ্ঞেস করো।`
  )
}

class SarvamCall {
  constructor(twilioWs, genai, verifyToken) {
    this.tw = twilioWs
    this.genai = genai
    this.verifyToken = verifyToken
    this.callRecordId = null
    this.streamSid = null
    this.params = {}
    this.history = []
    this.startedAt = Date.now()
    this.ended = false
    this.speaking = false
    this.playTimer = null
    this.awaitingHangupConfirm = false
    this.userTurns = 0
    this.pendingGen = null
    this.maxTimer = setTimeout(() => this.hangup('সময় শেষ হয়ে যাচ্ছে বস, রাখছি এখন। আল্লাহ হাফেজ।'), MAX_CALL_MIN() * 60_000)
  }

  // ── Sarvam streaming STT ───────────────────────────────────────────────────
  openStt() {
    const qs = new URLSearchParams({
      'language-code': process.env.VOICE_RELAY_STT_LANGUAGE || 'bn-IN',
      model: STT_MODEL(),
      sample_rate: '8000',
      vad_signals: 'true',
      high_vad_sensitivity: 'false',
    })
    this.stt = new WebSocket(`${SARVAM_STT_URL}?${qs}`, {
      headers: { 'Api-Subscription-Key': process.env.SARVAM_API_KEY || '' },
    })
    this.stt.on('open', () => { this.sttReady = true; console.log('[sarvam-media] STT ws OPEN') })
    this.stt.on('message', (raw) => this.onSttMessage(raw))
    this.stt.on('unexpected-response', (_r, res) => console.warn('[sarvam-media] STT unexpected-response', res.statusCode))
    this.stt.on('error', (e) => console.warn('[sarvam-media] STT ws error:', e.message))
    this.stt.on('close', (c, r) => { this.sttReady = false; console.log(`[sarvam-media] STT ws CLOSE code=${c} reason=${String(r||'').slice(0,80)} framesSent=${this._frames||0}`) })
  }

  onSttMessage(raw) {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (msg.type === 'error') console.warn('[sarvam-media] STT error:', JSON.stringify(msg.data).slice(0, 160))
    if (msg.type === 'events') {
      const sig = msg.data?.signal_type
      // Caller started talking → barge in: abort generation + cut our voice at once.
      if (sig === 'START_SPEECH' && (this.speaking || this.pcmQueue?.length)) { console.log('[sarvam-media] barge-in'); this.bargeIn() }
      return
    }
    if (msg.type === 'data') {
      const text = String(msg.data?.transcript ?? '').trim()
      if (text) { console.log(`[sarvam-media] heard: "${text.slice(0, 60)}"`); this.onUserUtterance(text) }
    }
  }

  onUserUtterance(text) {
    if (this.ended || this.closing) return
    this.userTurns++
    if (isUnintelligibleTranscript(text)) {
      this.say('দুঃখিত বস, একটু কেটে গেল — আরেকবার বলবেন?')
      return
    }
    // Deterministic hang-up: end-signal → confirm once → yes hangs up.
    if (this.awaitingHangupConfirm) {
      this.awaitingHangupConfirm = false
      if (isHangupConfirmation(text)) { this.hangup('আচ্ছা বস, রাখছি তাহলে। আল্লাহ হাফেজ।'); return }
    } else if (endSignalFromCaller(text)) {
      this.awaitingHangupConfirm = true
      this.history.push({ role: 'user', text })
      this.say('তাহলে কি এখন কল রাখব বস?')
      return
    }
    this.history.push({ role: 'user', text })
    void this.respond()
  }

  async respond() {
    if (this.ended) return
    this.pendingGen?.abort()
    const ac = new AbortController()
    this.pendingGen = ac
    const contents = this.history.slice(-16).map((t) => ({
      role: t.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: t.text }],
    }))
    let raw = ''
    try {
      const res = await this.genai.models.generateContent({
        model: MODEL(),
        contents,
        config: {
          systemInstruction: buildPrompt({ purpose: this.params.purpose, recipientName: this.params.recipientName }),
          abortSignal: ac.signal,
          temperature: 0.5,
          maxOutputTokens: 220,
          thinkingConfig: { thinkingBudget: 0 },
        },
      })
      raw = res.text ?? ''
    } catch (e) {
      if (ac.signal.aborted) return
      console.warn('[sarvam-media] gemini error:', e.message)
      raw = 'দুঃখিত বস, একটু সমস্যা হলো — আবার বলবেন?'
    }
    if (ac.signal.aborted) return
    const sawEnd = raw.includes(END_MARKER)
    const reply = raw.replace(END_MARKER, '').trim()
    if (reply && !this.ended) {
      this.history.push({ role: 'assistant', text: reply })
      await this.say(reply) // one utterance per turn — no fragmenting, no filler
    }
    // Model decided the caller wants to end → hang up once the goodbye has played.
    if (sawEnd) {
      console.log(`[sarvam-media] END_CALL from model — call ${this.callRecordId}`)
      this.pendingHangup = true
      if (!this.speaking) this.close()
    }
  }

  // ── Sarvam Bulbul TTS → μ-law → Twilio (queued) ────────────────────────────
  /** Synthesize one line and enqueue it for playback. Also used for greeting/prompts. */
  async say(text) { await this.sayLine(text) }

  async sayLine(text) {
    if (this.ended || !text) return
    try {
      const r = await fetch(SARVAM_TTS_URL, {
        method: 'POST',
        headers: { 'api-subscription-key': process.env.SARVAM_API_KEY || '', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text.slice(0, 400),
          target_language_code: process.env.VOICE_RELAY_STT_LANGUAGE || 'bn-IN',
          model: TTS_MODEL(),
          speaker: TTS_SPEAKER(),
          speech_sample_rate: 8000,
        }),
      })
      const j = await r.json()
      if (!j.audios?.[0]) { console.warn('[sarvam-media] TTS no audio http=' + r.status + ':', JSON.stringify(j).slice(0, 140)); return }
      if (this.ended) return
      this.enqueuePcm(wavToPcm16(Buffer.from(j.audios[0], 'base64')))
    } catch (e) {
      console.warn('[sarvam-media] TTS error:', e.message)
    }
  }

  /**
   * Hand a whole line of audio to Twilio AT ONCE — it buffers and plays at 8 kHz on
   * its own clock. (The old 20 ms setInterval pacer jittered under the busy worker
   * event loop, so Twilio underran and the owner heard "ঝিরঝির" static.) We learn
   * when a line finishes from the echoed `mark`, and stop it with `clear`.
   */
  enqueuePcm(pcm) {
    if (this.ended || !this.streamSid) return
    this._buf = null // drop any half-collected caller audio; we're taking the floor
    const mu = pcm16ToMuLaw(pcm)
    for (let off = 0; off < mu.length; off += 160) {
      let frame = mu.subarray(off, off + 160)
      if (frame.length < 160) frame = Buffer.concat([frame, Buffer.alloc(160 - frame.length, 0xff)]) // μ-law silence pad
      this.sendTwilio({ event: 'media', streamSid: this.streamSid, media: { payload: frame.toString('base64') } })
    }
    this._markSeq = (this._markSeq || 0) + 1
    const name = 'm' + this._markSeq
    this._marks = this._marks || new Set()
    this._marks.add(name)
    this.speaking = true
    this.sendTwilio({ event: 'mark', streamSid: this.streamSid, mark: { name } })
  }

  /** Twilio echoes a mark once that audio has actually PLAYED out. */
  onMark(name) {
    this._marks?.delete(name)
    if (!this._marks || this._marks.size === 0) {
      this.speaking = false
      if (this.pendingHangup && !this._closed) setTimeout(() => this.close(), 300)
    }
  }

  haltPlayback() { this.speaking = false; this._marks?.clear() }

  /** Caller barged in — abort generation and cut Twilio's buffered audio at once. */
  bargeIn() {
    this.pendingGen?.abort()
    this._marks?.clear()
    if (this.speaking) {
      this.speaking = false
      this.sendTwilio({ event: 'clear', streamSid: this.streamSid })
    }
  }

  // ── Twilio Media Streams protocol ──────────────────────────────────────────
  onTwilioMessage(raw) {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    switch (msg.event) {
      case 'start': {
        this.streamSid = msg.start?.streamSid ?? msg.streamSid
        this.params = msg.start?.customParameters ?? {}
        // Media Streams can't carry the token in the URL, so verify it from the
        // <Parameter> values now. Reject anything that isn't ours.
        const okTok = this.verifyToken?.(this.params.id, Number(this.params.exp), this.params.t)
        if (!okTok) {
          console.warn('[sarvam-media] start rejected — bad token')
          this.close()
          return
        }
        this.callRecordId = this.params.id ?? null
        console.log(`[sarvam-media] verified — call ${this.callRecordId}`)
        this.openStt()
        if (this.params.firstMessage) this.say(this.params.firstMessage)
        break
      }
      case 'media': {
        // Caller audio → decode μ-law → PCM16 → Sarvam STT. While the AGENT is
        // speaking we DON'T forward audio: on a phone the agent's own voice echoes
        // back, Sarvam transcribes it, and the agent ends up answering itself — the
        // owner's "উল্টাপাল্টা বুঝতেছে". Half-duplex (listen only when not speaking)
        // keeps understanding correct.
        if (this.sttReady && !this.speaking && msg.media?.payload) {
          // Batch ~100 ms of caller audio, then send ONE WAV blob — Sarvam STT's
          // audio.encoding enum only accepts 'audio/wav' (live-verified 2026-07-18).
          this._buf = this._buf ? Buffer.concat([this._buf, muLawToPcm16(Buffer.from(msg.media.payload, 'base64'))])
                                : muLawToPcm16(Buffer.from(msg.media.payload, 'base64'))
          if (this._buf.length >= 1600) { // 100 ms @ 8 kHz 16-bit = 1600 bytes
            const wav = pcm16ToWav(this._buf, 8000)
            this._buf = null
            try {
              this.stt.send(JSON.stringify({ audio: { data: wav.toString('base64'), sample_rate: '8000', encoding: 'audio/wav' } }))
            } catch { /* stt socket mid-close */ }
          }
        }
        break
      }
      case 'mark':
        if (msg.mark?.name) this.onMark(msg.mark.name)
        break
      case 'dtmf':
        // STT-proof hang-up: any key ends the call.
        if (msg.dtmf?.digit) this.hangup('আচ্ছা বস, রাখছি। আল্লাহ হাফেজ।')
        break
      case 'stop':
        this.close()
        break
      default:
        break
    }
  }

  sendTwilio(obj) {
    if (this.tw.readyState === this.tw.OPEN) {
      try { this.tw.send(JSON.stringify(obj)) } catch { /* closed */ }
    }
  }

  hangup(goodbye) {
    if (this.ended || this.closing) return
    // Play the goodbye (don't set `ended` yet, or enqueuePcm would drop it), stop
    // taking new input, and close once the goodbye's mark plays out (onMark) — with
    // a safety timeout in case the mark never comes back.
    this.closing = true
    this.pendingHangup = true
    this.say(goodbye)
    setTimeout(() => this.close(), 6000)
  }

  close() {
    if (this._closed) return
    this._closed = true
    this.ended = true
    clearTimeout(this.maxTimer)
    this.haltPlayback()
    try { this.stt?.send(JSON.stringify({ type: 'flush' })) } catch { /* */ }
    try { this.stt?.close() } catch { /* */ }
    try { this.tw?.close() } catch { /* */ }
    console.log(`[sarvam-media] call ${this.callRecordId} closed — ${this.userTurns} user turns, ${Math.round((Date.now() - this.startedAt) / 1000)}s`)
  }
}

/**
 * Attach the Sarvam Media Streams handler to an existing http.Server's upgrade on
 * path /media. `verify(id, exp, t)` reuses the relay token check. Returns nothing.
 */
export function handleSarvamMediaUpgrade({ req, socket, head, wss, verifyRelayToken }) {
  if (!process.env.GEMINI_API_KEY || !process.env.SARVAM_API_KEY) {
    console.warn('[sarvam-media] GEMINI_API_KEY / SARVAM_API_KEY missing — refusing')
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
    socket.destroy()
    return
  }
  const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  wss.handleUpgrade(req, socket, head, (ws) => {
    const call = new SarvamCall(ws, genai, verifyRelayToken)
    console.log('[sarvam-media] media socket open — awaiting start+token')
    ws.on('message', (raw) => call.onTwilioMessage(raw))
    ws.on('close', () => call.close())
    ws.on('error', (e) => console.warn('[sarvam-media] twilio ws error:', e.message))
  })
}

export { muLawToPcm16, pcm16ToMuLaw, wavToPcm16 }
