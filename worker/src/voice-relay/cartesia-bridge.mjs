/**
 * Cartesia bridge — two-way realtime Bangla calls over Twilio MEDIA STREAMS,
 * replacing ConversationRelay so the agent can speak in a Cartesia Sonic voice
 * (owner verdict: Google's bn TTS "not as human"; Cartesia has natural Bangla).
 *
 * Unlike the ConversationRelay relay (server.mjs — Twilio does STT/TTS, we only
 * exchange text), here WE own the whole audio loop:
 *
 *   Twilio <Connect><Stream>  ⇄  this bridge (raw μ-law 8k frames both ways)
 *     inbound audio → μ-law→PCM16 →×3 upsample→ OpenAI Realtime STT
 *                      (gpt-4o-transcribe, bn — the proven Bangla STT of this
 *                      repo; Cartesia's own Ink STT has NO Bengali)
 *     final utterance → Gemini flash (streaming, thinking off — same brain as
 *                      the relay) → sentence chunks → Cartesia TTS websocket
 *                      (sonic, language bn, raw pcm_mulaw 8000) → Twilio media
 *
 * Turn-taking: OpenAI server VAD endpoints the utterance (silence window is
 * env-tunable) + a small grace debounce merges back-to-back finals — the exact
 * fix for the "AI starts speaking before the caller finished" complaint.
 * Barge-in: sustained caller speech while the agent is speaking → abort Gemini,
 * cancel the Cartesia context, send Twilio `clear`, and truncate history to the
 * audio that was actually played (tracked via Twilio `mark` acks).
 *
 * Auth, reporting and diagnostics mirror server.mjs: HMAC-signed wss URL
 * (AGENT_INTERNAL_TOKEN, same `relay:` scheme), post-call transcript+summary to
 * /api/assistant/voice-call/relay-report, /health with rolling turn/report log.
 * Twilio requires TLS — put VOICE_BRIDGE_PORT behind the same Caddy/nginx as the
 * relay and set VOICE_BRIDGE_PUBLIC_WSS_URL to the public wss URL.
 */

import http from 'http'
import { randomUUID } from 'crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { GoogleGenAI } from '@google/genai'
import { logCost } from '../cost-log.mjs'
import { signRelayToken } from './server.mjs'

const BRIDGE_MODEL = () => process.env.VOICE_RELAY_MODEL_ID || 'gemini-3.5-flash'
const MAX_CALL_MINUTES = () => Number(process.env.VOICE_CALL_MAX_MINUTES) || 10
const IDLE_HANGUP_SEC = () => Number(process.env.VOICE_RELAY_IDLE_HANGUP_SEC) || 30
/** Silence (ms) OpenAI's server VAD waits before ending the caller's turn. */
const VAD_SILENCE_MS = () => Number(process.env.VOICE_BRIDGE_VAD_SILENCE_MS) || 900
/** Extra debounce merging back-to-back STT finals into ONE user turn. */
const TURN_GRACE_MS = () => Number(process.env.VOICE_BRIDGE_TURN_GRACE_MS) || 400
/** Caller speech must persist this long (ms) to count as barge-in, not a cough. */
const BARGE_HOLD_MS = () => Number(process.env.VOICE_BRIDGE_BARGE_HOLD_MS) || 300
const CARTESIA_VERSION = '2026-03-01'
const CARTESIA_MODEL = () => process.env.CARTESIA_TTS_MODEL || 'sonic-3'
/** How long Cartesia may buffer text for prosody before emitting audio. */
const CARTESIA_BUFFER_MS = () => Number(process.env.CARTESIA_MAX_BUFFER_DELAY_MS) || 1000
const STT_MODEL = () => process.env.BANGLA_STT_MODEL || 'gpt-4o-transcribe'
const END_MARKER = '[[END_CALL]]'
const SENTENCE_BOUNDARY = /[।.?!\n]/
const MIN_TTS_CHUNK = 12

/** First sentence boundary at/after MIN_TTS_CHUNK, or -1 (short heads merge forward). */
export function findSentenceCut(text) {
  for (let i = MIN_TTS_CHUNK; i < text.length; i++) {
    if (SENTENCE_BOUNDARY.test(text[i])) return i
  }
  return -1
}

/** Same domain-vocabulary STT prompt as src/agent/lib/voice-bangla.ts (keep in sync). */
const STT_PROMPT =
  'বাংলায় কথা বলা হচ্ছে। Bangladeshi Bangla and Banglish only — not Hindi, not Devanagari. ' +
  'প্রসঙ্গ: ALMA Lifestyle, ALMA Trading, CDIT, অর্ডার, ডেলিভারি, স্টক, কাস্টমার, টাকা, নামাজ।'

function buildSystemPrompt({ purpose, recipientName }) {
  return (
    `তুমি মালিকের ব্যক্তিগত সহকারী — ${recipientName ? recipientName + ' কে' : 'একজনকে'} ` +
    `মালিকের পক্ষ থেকে ফোন করেছ। উদ্দেশ্য: ${purpose || 'মালিকের বার্তা পৌঁছে দেওয়া'}।\n` +
    `নিয়ম:\n` +
    `- শুধুই সহজ, বিনয়ী, কথ্য বাংলায় কথা বলো। এটা ফোন কল — প্রতিটা উত্তর ১-৩টা ছোট বাক্যে, কোনো markdown/emoji/তালিকা নয়।\n` +
    `- অন্য পক্ষের কথা মন দিয়ে শোনো, প্রয়োজনীয় তথ্য আদায় করো।\n` +
    `- উদ্দেশ্য পূরণ হয়ে গেলে ভদ্রভাবে বিদায় নাও এবং বিদায়-বাক্যের একদম শেষে ${END_MARKER} লেখো (ওটা উচ্চারিত হবে না)।\n` +
    `- অপ্রাসঙ্গিক/হারাম বিষয়ে যেও না; না জানলে বলো মালিককে জিজ্ঞেস করে জানানো হবে।`
  )
}

// ── μ-law 8k → PCM16 24k (OpenAI's input format) ────────────────────────────

const MULAW_TABLE = new Int16Array(256)
for (let i = 0; i < 256; i++) {
  const mu = ~i & 0xff
  const sign = mu & 0x80
  const exponent = (mu >> 4) & 0x07
  const mantissa = mu & 0x0f
  let sample = (((mantissa << 3) + 0x84) << exponent) - 0x84
  MULAW_TABLE[i] = sign ? -sample : sample
}

/** Decode μ-law bytes and linearly upsample 8 kHz → 24 kHz (×3). */
export function mulawToPcm24k(bytes, state) {
  const out = new Int16Array(bytes.length * 3)
  let prev = state.last
  for (let i = 0; i < bytes.length; i++) {
    const cur = MULAW_TABLE[bytes[i]]
    out[i * 3] = prev + Math.round((cur - prev) / 3)
    out[i * 3 + 1] = prev + Math.round(((cur - prev) * 2) / 3)
    out[i * 3 + 2] = cur
    prev = cur
  }
  state.last = prev
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength)
}

// Rolling diagnostics on /health (mirrors server.mjs relayDiag).
export const bridgeDiag = {
  lastTurns: [],
  lastReports: [],
  note(list, entry) {
    list.push({ ts: new Date().toISOString(), ...entry })
    if (list.length > 12) list.shift()
  },
}

/** Mint an OpenAI Realtime transcription session (same shape as the proven
 *  /api/assistant/stt-session route, but with SERVER VAD doing the endpointing). */
async function mintSttSession() {
  const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      expires_after: { anchor: 'created_at', seconds: 300 },
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            noise_reduction: { type: 'far_field' },
            transcription: { model: STT_MODEL(), language: 'bn', prompt: STT_PROMPT },
            turn_detection: {
              type: 'server_vad',
              threshold: Number(process.env.VOICE_BRIDGE_VAD_THRESHOLD) || 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: VAD_SILENCE_MS(),
            },
          },
        },
      },
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`stt mint HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`)
  const data = await res.json()
  const key = data.value ?? data.client_secret?.value
  if (!key) throw new Error('stt mint: no ephemeral key')
  return key
}

/** One live call: Twilio media stream ⇄ STT ⇄ Gemini ⇄ Cartesia TTS. */
class BridgeSession {
  constructor(ws, callRecordId, genai) {
    this.ws = ws // Twilio media-stream socket
    this.callRecordId = callRecordId
    this.genai = genai
    this.streamSid = null
    this.callSid = null
    this.params = {}
    this.history = [] // {role:'user'|'assistant', text}
    this.startedAt = Date.now()
    this.ended = false
    this.reported = false
    this.userTurns = 0
    this.charsSpoken = 0

    // STT state
    this.stt = null
    this.sttPartial = ''
    this.pendingUtterance = ''
    this.graceTimer = null
    this.speechStartedAt = 0
    this.upsample = { last: 0 }
    this.pcmQueue = [] // batched 24k PCM buffers awaiting send (~100ms each)
    this.pcmQueuedBytes = 0

    // LLM / TTS state
    this.abort = null
    this.tts = null
    this.ttsReady = null
    this.turnSeq = 0
    this.speakingTurn = null // {ctx, text, sentBytes, playedBytes, done, endCall}

    this.maxTimer = setTimeout(() => this.timeUp(), MAX_CALL_MINUTES() * 60_000)
    this.idleTimer = setTimeout(() => this.idleGiveUp(), IDLE_HANGUP_SEC() * 1000)
  }

  // ── Twilio protocol ────────────────────────────────────────────────────────

  sendTwilio(obj) {
    if (this.ws.readyState === this.ws.OPEN) {
      try { this.ws.send(JSON.stringify(obj)) } catch { /* socket died mid-send */ }
    }
  }

  onTwilioMessage(raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    switch (msg.event) {
      case 'start': {
        this.streamSid = msg.start?.streamSid ?? msg.streamSid ?? null
        this.callSid = msg.start?.callSid ?? null
        this.params = msg.start?.customParameters ?? {}
        void this.startPipelines()
        break
      }
      case 'media': {
        if (msg.media?.payload && msg.media?.track !== 'outbound') {
          this.onCallerAudio(Buffer.from(msg.media.payload, 'base64'))
        }
        break
      }
      case 'mark': {
        const t = this.speakingTurn
        if (t && typeof msg.mark?.name === 'string' && msg.mark.name.startsWith(`t${t.seq}:`)) {
          t.playedBytes = Number(msg.mark.name.slice(msg.mark.name.indexOf(':') + 1)) || t.playedBytes
          if (t.done && t.playedBytes >= t.sentBytes) this.onTurnFullyPlayed(t)
        }
        break
      }
      case 'stop':
        this.hangup('twilio_stop')
        break
      default:
        break
    }
  }

  /** Hang up: closing the media-stream socket ends <Connect><Stream>, and with
   *  no TwiML after it Twilio ends the call. */
  hangup(why) {
    if (this.ended) return
    this.ended = true
    console.log(`[cartesia-bridge] hangup (${why}) — call ${this.callRecordId}`)
    this.abort?.abort()
    try { this.ws.close() } catch { /* already closed */ }
  }

  idleGiveUp() {
    if (this.userTurns > 0 || this.ended) return
    bridgeDiag.note(bridgeDiag.lastReports, { call: this.callRecordId, idleHangup: true })
    this.hangup(`idle ${IDLE_HANGUP_SEC()}s`)
  }

  timeUp() {
    if (this.ended) return
    void this.speak('আমাদের কথার সময় শেষ হয়ে যাচ্ছে, তাই এখন রাখছি। আসসালামু আলাইকুম।', { endCall: true })
    // Belt-and-braces: even if TTS is dead and the farewell never sounds,
    // the call must not outlive its cap.
    setTimeout(() => this.hangup('time_up'), 15_000)
  }

  // ── Pipeline startup ──────────────────────────────────────────────────────

  async startPipelines() {
    try {
      this.ttsReady = this.connectCartesia()
      await Promise.all([this.connectStt(), this.ttsReady])
      const first = String(this.params.firstMessage || 'আসসালামু আলাইকুম।')
      await this.speak(first, { record: true })
    } catch (err) {
      console.warn('[cartesia-bridge] pipeline start failed:', err?.message ?? err)
      bridgeDiag.note(bridgeDiag.lastReports, {
        call: this.callRecordId,
        startError: String(err?.message ?? err).slice(0, 160),
      })
      this.hangup('pipeline_start_failed')
    }
  }

  connectCartesia() {
    return new Promise((resolve, reject) => {
      const url = `wss://api.cartesia.ai/tts/websocket?cartesia_version=${CARTESIA_VERSION}`
      const ws = new WebSocket(url, { headers: { 'X-API-Key': process.env.CARTESIA_API_KEY ?? '' } })
      const to = setTimeout(() => { try { ws.close() } catch { /* noop */ } reject(new Error('cartesia ws timeout')) }, 8000)
      ws.on('open', () => { clearTimeout(to); this.tts = ws; resolve() })
      ws.on('error', (err) => { clearTimeout(to); reject(new Error(`cartesia ws: ${err.message}`)) })
      ws.on('message', (raw) => this.onCartesiaMessage(raw.toString()))
      ws.on('close', () => { this.tts = null })
    })
  }

  async connectStt() {
    const key = await mintSttSession()
    return new Promise((resolve, reject) => {
      // Subprotocol auth — the exact proven scheme of useStreamingStt.ts.
      const ws = new WebSocket('wss://api.openai.com/v1/realtime', [
        'realtime',
        `openai-insecure-api-key.${key}`,
      ])
      const to = setTimeout(() => { try { ws.close() } catch { /* noop */ } reject(new Error('stt ws timeout')) }, 8000)
      ws.on('open', () => { clearTimeout(to); this.stt = ws; resolve() })
      ws.on('error', (err) => { clearTimeout(to); reject(new Error(`stt ws: ${err.message}`)) })
      ws.on('message', (raw) => this.onSttMessage(raw.toString()))
      ws.on('close', () => {
        this.stt = null
        // STT is the call's ears — without it the agent would monologue into
        // silence. End gracefully; the report explains what happened.
        if (!this.ended) {
          bridgeDiag.note(bridgeDiag.lastReports, { call: this.callRecordId, sttDied: true })
          this.hangup('stt_closed')
        }
      })
    })
  }

  // ── Caller audio → STT ────────────────────────────────────────────────────

  onCallerAudio(mulawBytes) {
    if (!this.stt || this.stt.readyState !== this.stt.OPEN) return
    this.pcmQueue.push(mulawToPcm24k(mulawBytes, this.upsample))
    this.pcmQueuedBytes += mulawBytes.length * 6 // ×3 samples ×2 bytes
    // Twilio sends 20ms frames; batch ~100ms per append to keep message rate sane.
    if (this.pcmQueuedBytes >= 4800) {
      const chunk = Buffer.concat(this.pcmQueue)
      this.pcmQueue = []
      this.pcmQueuedBytes = 0
      try {
        this.stt.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') }))
      } catch { /* socket died mid-send */ }
    }
  }

  onSttMessage(raw) {
    let evt
    try { evt = JSON.parse(raw) } catch { return }
    switch (evt.type) {
      case 'input_audio_buffer.speech_started':
        this.speechStartedAt = Date.now()
        // Speaking + caller talks → candidate barge-in; confirmed after BARGE_HOLD_MS.
        if (this.speakingTurn && !this.speakingTurn.bargeTimer) {
          this.speakingTurn.bargeTimer = setTimeout(() => this.bargeIn(), BARGE_HOLD_MS())
        }
        break
      case 'input_audio_buffer.speech_stopped':
        if (this.speakingTurn?.bargeTimer && Date.now() - this.speechStartedAt < BARGE_HOLD_MS()) {
          clearTimeout(this.speakingTurn.bargeTimer) // just a cough / echo blip
          this.speakingTurn.bargeTimer = null
        }
        break
      case 'conversation.item.input_audio_transcription.delta':
        if (typeof evt.delta === 'string') this.sttPartial += evt.delta
        break
      case 'conversation.item.input_audio_transcription.completed': {
        const text = (typeof evt.transcript === 'string' && evt.transcript.trim()) || this.sttPartial.trim()
        this.sttPartial = ''
        if (!text) break
        this.userTurns++
        clearTimeout(this.idleTimer)
        // Grace merge: a thinking pause splits one thought into two VAD finals —
        // merge anything arriving within TURN_GRACE_MS into ONE user turn. This
        // (plus the VAD silence window) is the anti-"AI talks over me" fix.
        this.pendingUtterance = this.pendingUtterance ? `${this.pendingUtterance} ${text}` : text
        this.abort?.abort()
        clearTimeout(this.graceTimer)
        this.graceTimer = setTimeout(() => {
          const utterance = this.pendingUtterance
          this.pendingUtterance = ''
          if (!utterance || this.ended) return
          this.history.push({ role: 'user', text: utterance })
          void this.respond()
        }, TURN_GRACE_MS())
        break
      }
      case 'error':
        console.warn('[cartesia-bridge] stt error:', evt.error?.message ?? raw.slice(0, 160))
        break
      default:
        break
    }
  }

  // ── Gemini turn → Cartesia ────────────────────────────────────────────────

  async respond() {
    this.abort?.abort()
    const ac = new AbortController()
    this.abort = ac

    const contents = this.history.slice(-16).map((t) => ({
      role: t.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: t.text }],
    }))
    const watchdog = setTimeout(() => ac.abort(new Error('llm_timeout')), 12_000)
    const startedAt = Date.now()
    const turn = this.beginTurn()

    let full = ''
    let pending = ''
    let sawEnd = false
    try {
      const stream = await this.genai.models.generateContentStream({
        model: BRIDGE_MODEL(),
        contents,
        config: {
          systemInstruction: buildSystemPrompt({
            purpose: this.params.purpose,
            recipientName: this.params.recipientName,
          }),
          abortSignal: ac.signal,
          temperature: 0.6,
          maxOutputTokens: 300,
          thinkingConfig: { thinkingBudget: 0 },
        },
      })
      for await (const chunk of stream) {
        if (ac.signal.aborted) break
        let token = chunk.text ?? ''
        if (!token) continue
        full += token
        pending += token
        if (full.includes(END_MARKER)) {
          sawEnd = true
          pending = pending.replace(END_MARKER, '')
          for (let i = END_MARKER.length - 1; i > 0; i--) {
            if (pending.endsWith(END_MARKER.slice(0, i))) { pending = pending.slice(0, -i); break }
          }
        }
        // Clause-level batching: Cartesia gets whole sentences, never crumbs —
        // steadier prosody than raw token forwarding ever gave the relay. A
        // boundary inside the first MIN_TTS_CHUNK chars is skipped so a tiny
        // "জি।" rides along with the sentence after it.
        let cut
        while ((cut = findSentenceCut(pending)) >= 0) {
          this.ttsSend(turn, pending.slice(0, cut + 1), false)
          pending = pending.slice(cut + 1)
        }
        if (sawEnd) break
      }
    } catch (err) {
      if (!ac.signal.aborted || String(ac.signal.reason?.message) === 'llm_timeout') {
        console.warn('[cartesia-bridge] LLM stream failed:', err?.message ?? err)
        bridgeDiag.note(bridgeDiag.lastTurns, {
          call: this.callRecordId,
          ms: Date.now() - startedAt,
          error: String(err?.message ?? err).slice(0, 160),
        })
        const fallback = full
          ? ' দুঃখিত, লাইনে একটু সমস্যা হলো। আবার বলুন?'
          : 'দুঃখিত, বুঝতে একটু সমস্যা হলো — আরেকবার বলবেন?'
        full += fallback
        pending += fallback
      }
    } finally {
      clearTimeout(watchdog)
    }

    if (ac.signal.aborted && String(ac.signal.reason?.message) !== 'llm_timeout') {
      // Barged / superseded mid-generation. Whatever reached Cartesia may have
      // sounded — record it (bargeIn() trims to what was truly heard), close the
      // context, and let the newer turn own the floor.
      const spoken = turn.text.replace(END_MARKER, '').trim()
      if (spoken && !turn.recorded) {
        turn.recorded = true
        this.history.push({ role: 'assistant', text: spoken })
      }
      this.ttsSend(turn, '', true)
      bridgeDiag.note(bridgeDiag.lastTurns, { call: this.callRecordId, ms: Date.now() - startedAt, aborted: true })
      return
    }

    turn.endCall = sawEnd
    this.ttsSend(turn, pending.replace(END_MARKER, ''), true) // flush remainder, close context
    const spokenText = full.replace(END_MARKER, '').trim()
    if (spokenText && !turn.recorded) {
      turn.recorded = true
      this.history.push({ role: 'assistant', text: spokenText })
    }
    bridgeDiag.note(bridgeDiag.lastTurns, { call: this.callRecordId, ms: Date.now() - startedAt, chars: full.length })
    console.log(`[cartesia-bridge] turn ${Date.now() - startedAt}ms — call ${this.callRecordId}`)
  }

  /** Speak a fixed line outside the LLM loop (greeting / farewell). */
  async speak(text, opts = {}) {
    try { await this.ttsReady } catch { return }
    const turn = this.beginTurn()
    turn.endCall = Boolean(opts.endCall)
    if (opts.record) this.history.push({ role: 'assistant', text })
    turn.recorded = true
    this.ttsSend(turn, text, true)
  }

  beginTurn() {
    // A previous turn may still have audio queued in Twilio (quick reply before
    // the tail finished sounding) — flush it so turns never overlap on the line.
    const stale = this.speakingTurn
    if (stale && !(stale.done && stale.playedBytes >= stale.sentBytes)) {
      if (stale.bargeTimer) clearTimeout(stale.bargeTimer)
      try { this.tts?.send(JSON.stringify({ context_id: stale.ctx, cancel: true })) } catch { /* noop */ }
      this.sendTwilio({ event: 'clear', streamSid: this.streamSid })
    }
    const turn = {
      seq: ++this.turnSeq,
      ctx: randomUUID(),
      text: '',
      sentBytes: 0,
      playedBytes: 0,
      done: false, // Cartesia finished emitting audio for this context
      endCall: false,
      recorded: false,
      bargeTimer: null,
    }
    this.speakingTurn = turn
    return turn
  }

  ttsSend(turn, text, last) {
    if (!this.tts || this.tts.readyState !== this.tts.OPEN || this.speakingTurn !== turn) return
    if (text) { turn.text += text; this.charsSpoken += text.length }
    if (!text && !last) return
    try {
      this.tts.send(JSON.stringify({
        model_id: CARTESIA_MODEL(),
        voice: { mode: 'id', id: process.env.CARTESIA_VOICE_ID ?? '' },
        language: 'bn',
        output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
        max_buffer_delay_ms: CARTESIA_BUFFER_MS(),
        transcript: text,
        context_id: turn.ctx,
        continue: !last,
      }))
    } catch { /* socket died mid-send */ }
  }

  onCartesiaMessage(raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    const turn = this.speakingTurn
    if (!turn || msg.context_id !== turn.ctx) return // stale context (barged) — drop
    if (msg.type === 'chunk' && msg.data) {
      const bytes = Buffer.from(msg.data, 'base64')
      turn.sentBytes += bytes.length
      this.sendTwilio({ event: 'media', streamSid: this.streamSid, media: { payload: msg.data } })
      // Mark carries the cumulative byte count; Twilio echoes it back when this
      // chunk has actually SOUNDED — that ack is our playback progress meter.
      this.sendTwilio({ event: 'mark', streamSid: this.streamSid, mark: { name: `t${turn.seq}:${turn.sentBytes}` } })
    } else if (msg.type === 'done') {
      turn.done = true
      if (turn.playedBytes >= turn.sentBytes) this.onTurnFullyPlayed(turn)
    } else if (msg.type === 'error') {
      console.warn('[cartesia-bridge] tts error:', msg.error ?? raw.slice(0, 160))
      turn.done = true
    }
  }

  onTurnFullyPlayed(turn) {
    if (turn.bargeTimer) { clearTimeout(turn.bargeTimer); turn.bargeTimer = null }
    if (this.speakingTurn === turn) this.speakingTurn = null
    if (turn.endCall) {
      // Goodbye has fully sounded — a short beat, then hang up.
      setTimeout(() => this.hangup('end_marker'), 600)
    }
  }

  /** Caller talked over the agent: stop generating, cancel TTS, flush Twilio's
   *  buffer, and trim history to the fraction that was actually played. */
  bargeIn() {
    const turn = this.speakingTurn
    if (!turn || this.ended) return
    turn.bargeTimer = null
    this.speakingTurn = null
    this.abort?.abort()
    try { this.tts?.send(JSON.stringify({ context_id: turn.ctx, cancel: true })) } catch { /* noop */ }
    this.sendTwilio({ event: 'clear', streamSid: this.streamSid })
    // μ-law 8k ≈ uniform bytes-per-second, so played/sent bytes ≈ the fraction
    // of the reply the caller heard — trim the recorded turn to that.
    const lastTurn = this.history[this.history.length - 1]
    if (turn.recorded && lastTurn?.role === 'assistant' && turn.sentBytes > 0) {
      const frac = Math.min(1, turn.playedBytes / turn.sentBytes)
      const heard = turn.text.slice(0, Math.round(turn.text.length * frac)).trim()
      lastTurn.text = heard ? `${heard} —` : '(কিছু বলার আগেই থেমে গেছে)'
    }
    console.log(`[cartesia-bridge] barge-in — call ${this.callRecordId}`)
  }

  // ── Teardown + report ─────────────────────────────────────────────────────

  async close() {
    clearTimeout(this.maxTimer)
    clearTimeout(this.idleTimer)
    clearTimeout(this.graceTimer)
    this.ended = true
    this.abort?.abort()
    try { this.stt?.close() } catch { /* noop */ }
    try { this.tts?.close() } catch { /* noop */ }
    if (this.reported) return
    this.reported = true
    try {
      await this.report()
      bridgeDiag.note(bridgeDiag.lastReports, { call: this.callRecordId, ok: true, turns: this.history.length })
    } catch (err) {
      console.warn('[cartesia-bridge] report failed:', err?.message ?? err)
      bridgeDiag.note(bridgeDiag.lastReports, {
        call: this.callRecordId,
        ok: false,
        turns: this.history.length,
        error: String(err?.message ?? err).slice(0, 160),
      })
    }
  }

  /** Same relay-report contract as server.mjs — transcript + Gemini summary. */
  async report() {
    const appUrl = (process.env.APP_URL ?? '').replace(/\/$/, '')
    const token = process.env.AGENT_INTERNAL_TOKEN
    if (!appUrl || !token || !this.callRecordId) return

    const durationSecs = Math.round((Date.now() - this.startedAt) / 1000)
    const transcript = this.history.map((t) => ({
      role: t.role === 'assistant' ? 'agent' : 'user',
      message: t.text,
    }))

    let summary = null
    if (this.history.length) {
      try {
        const convoText = this.history
          .map((t) => `${t.role === 'assistant' ? 'এজেন্ট' : 'ব্যক্তি'}: ${t.text}`)
          .join('\n')
        const res = await this.genai.models.generateContent({
          model: BRIDGE_MODEL(),
          contents: `এই ফোন কথোপকথনের ২-৩ বাক্যের বাংলা সারাংশ লেখো (মূল তথ্য/সিদ্ধান্তসহ):\n\n${convoText}`,
          config: { abortSignal: AbortSignal.timeout(8_000), thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 200 },
        })
        summary = res.text?.trim() || null
      } catch { /* summary is best-effort */ }
    }

    const mins = durationSecs / 60
    void logCost({
      provider: 'twilio',
      kind: 'call',
      units: { callSid: this.callSid ?? this.callRecordId, bridge: true, seconds: durationSecs },
      costUsd: mins * 0.02, // voice minute + media-streams fee ≈ safe estimate
      jobId: this.callSid ?? this.callRecordId,
      dedupKey: `bridge-call:${this.callRecordId}`,
    })
    if (this.charsSpoken > 0) {
      void logCost({
        provider: 'cartesia',
        kind: 'tts',
        units: { chars: this.charsSpoken, sttMinutes: Number(mins.toFixed(2)) },
        // Sonic chars + OpenAI realtime STT minutes, env-tunable rate.
        costUsd:
          (this.charsSpoken / 1000) * (Number(process.env.CARTESIA_USD_PER_1K_CHARS) || 0.05) +
          mins * 0.006,
        jobId: this.callSid ?? this.callRecordId,
        dedupKey: `bridge-tts:${this.callRecordId}`,
      })
    }

    const body = JSON.stringify({
      callRecordId: this.callRecordId,
      callSid: this.callSid,
      transcript,
      summary,
      durationSecs,
      status: this.userTurns > 0 ? 'completed' : 'no_answer',
    })
    let lastErr
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${appUrl}/api/assistant/voice-call/relay-report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body,
          signal: AbortSignal.timeout(20_000),
        })
        if (res.ok) return
        lastErr = new Error(`relay-report HTTP ${res.status}`)
      } catch (err) {
        lastErr = err
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    throw lastErr
  }
}

export function startCartesiaBridgeServer() {
  const port = Number(process.env.VOICE_BRIDGE_PORT ?? 3101)
  const missing = ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'CARTESIA_API_KEY', 'CARTESIA_VOICE_ID', 'AGENT_INTERNAL_TOKEN']
    .filter((k) => !process.env[k])
  if (missing.length) {
    console.warn(`[cartesia-bridge] ${missing.join(', ')} missing — bridge not started`)
    return null
  }

  const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

  const recentUpgrades = []
  const noteUpgrade = (entry) => {
    recentUpgrades.push({ ts: new Date().toISOString(), ...entry })
    if (recentUpgrades.length > 10) recentUpgrades.shift()
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        service: 'cartesia-bridge',
        recentUpgrades,
        lastTurns: bridgeDiag.lastTurns,
        lastReports: bridgeDiag.lastReports,
      }))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })

  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const id = url.searchParams.get('id')?.trim()
    const exp = Number(url.searchParams.get('exp'))
    const t = url.searchParams.get('t')?.trim() ?? ''
    const from = req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '?'
    // Same HMAC scheme + secret as the relay (signRelayToken) — one trust root.
    const ok = url.pathname === '/media' && id && Number.isFinite(exp) && Date.now() <= exp && t === signRelayToken(id, exp)
    if (!ok) {
      const reason = url.pathname !== '/media' ? `bad path ${url.pathname}` : 'token verify failed'
      noteUpgrade({ ok: false, reason, id: id ?? null, from })
      console.warn(`[cartesia-bridge] upgrade rejected (${reason}) from ${from}`)
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    noteUpgrade({ ok: true, id, from })
    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = new BridgeSession(ws, id, genai)
      console.log(`[cartesia-bridge] session open — call ${id}`)
      ws.on('message', (raw) => session.onTwilioMessage(raw.toString()))
      ws.on('close', () => {
        console.log(`[cartesia-bridge] session closed — call ${id}`)
        void session.close()
      })
      ws.on('error', (err) => console.warn('[cartesia-bridge] ws error:', err.message))
    })
  })

  server.listen(port, '0.0.0.0', () => {
    console.log(`[cartesia-bridge] listening on :${port} (LLM ${BRIDGE_MODEL()}, TTS ${CARTESIA_MODEL()}, STT ${STT_MODEL()})`)
  })

  return server
}
