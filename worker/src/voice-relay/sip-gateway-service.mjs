/**
 * ALMA self-hosted SIP gateway — Phase 1 (outbound), NGS replacement.
 *
 * Sits between our own Asterisk (on the VPS) and the unchanged Gemini Live bot
 * (worker/scripts/gemini-live-bot.mjs). Asterisk owns the SIP trunk + PSTN leg;
 * this gateway owns call CONTROL and the AUDIO BRIDGE, and speaks to the bot in
 * the EXACT same WS frame dialect NGS/Twilio use — so the bot needs no rewrite.
 *
 * Three surfaces:
 *  1. Control API (HTTP) — mirrors the NGS Programmable Voice API so voice-call.ts
 *     can drive it the same way it drives NGS:
 *        POST   /api/v1/call            place a call  -> { call_id, status }
 *        DELETE /api/v1/call/{id}       hang up
 *        GET    /api/v1/call/{id}       state
 *        PUT    /api/v1/call/{id}       live-modify / transfer (parses <Dial to=…>)
 *     Auth: X-Authorization: SIP_GATEWAY_KEY + X-Authorization-Secret: SIP_GATEWAY_SECRET
 *     (same header shape as NGS). Vercel (voice-call.ts) hits POST/DELETE/GET; the
 *     bot hits DELETE/PUT for hang-up/transfer via the `ctrl` param we inject.
 *  2. ARI client (WS events + REST) — originates the call through the trunk, drops
 *     it into our Stasis app on answer, bridges it to an externalMedia AudioSocket
 *     channel, and does hang-up / transfer.
 *  3. AudioSocket TCP server — Asterisk's externalMedia channel connects here and
 *     streams slin 8k both ways; we transcode slin<->μ-law and pump the NGS-shaped
 *     media frames to/from the bot ws.
 *
 * Media path (proven seam = the bot's μ-law 8k base64 WS frames):
 *   caller  <-PSTN->  Asterisk  <-AudioSocket slin8k->  gateway  <-μ-law8k WS->  bot
 *
 * Fail-safe: if ARI is not configured (SIP creds absent) the process still starts
 * and the control API answers 503 — it NEVER crash-loops a worker deploy. SIP is
 * fully behind VOICE_CALL_PROVIDER='sip'; NGS stays primary + fallback until this
 * is proven 100% on a live call.
 *
 * Run:  pm2 start src/voice-relay/sip-gateway-service.mjs --name alma-sip-gateway \
 *          --node-args="-r dotenv/config"
 */
import http from 'node:http'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { WebSocket } from 'ws'
import { muLawToPcm16, pcm16ToMuLaw } from './sarvam-media.mjs'

// ── config (VPS .env only — secrets never in git) ────────────────────────────
const CTRL_PORT = Number(process.env.SIP_GATEWAY_PORT || 8770)
// Bind LOCALHOST by default. This API can originate PSTN calls and hang them up, so it must
// not sit open on the public internet — it was, until 2026-07-25, protected only by a shared
// secret travelling in plaintext HTTP. Everything that uses it today (the worker's one-way
// calls, the bot's hangup/transfer) runs on this same box. Exposing it for Vercel is a
// separate decision that needs TLS in front (see docs/SELF_HOSTED_SIP_ROADMAP.md).
// Comma-separated list. Default = loopback plus the Docker bridge gateway, so the TLS
// reverse proxy (a socat container fronted by Traefik, mirroring the existing relay-bridge)
// can reach it while the public internet still cannot: we never bind 0.0.0.0.
const CTRL_BIND = (process.env.SIP_GATEWAY_BIND || '127.0.0.1,172.16.0.1').split(',').map((x) => x.trim()).filter(Boolean)
const KEY = process.env.SIP_GATEWAY_KEY || ''
const SECRET = process.env.SIP_GATEWAY_SECRET || ''

const ARI_BASE = (process.env.ARI_BASE || 'http://127.0.0.1:8088').replace(/\/$/, '')
const ARI_USER = process.env.ARI_USER || ''
const ARI_PASS = process.env.ARI_PASS || ''
const ARI_APP = process.env.ARI_APP || 'alma-sip'
const TRUNK_ENDPOINT = process.env.SIP_TRUNK_ENDPOINT || 'alma' // Dial PJSIP/<num>@<endpoint>
const CALLER_ID = process.env.SIP_CALLER_ID || '' // From number shown to callee (trunk from_user is the fallback)

// AudioSocket: Asterisk (externalMedia client) dials AUDIOSOCKET_ADVERTISE_HOST:PORT;
// we bind AUDIOSOCKET_BIND:PORT. Advertise 127.0.0.1 when Asterisk + gateway share the VPS.
const AS_BIND = process.env.AUDIOSOCKET_BIND || '127.0.0.1'
const AS_PORT = Number(process.env.AUDIOSOCKET_PORT || 9092)
const AS_ADVERTISE = process.env.AUDIOSOCKET_ADVERTISE_HOST || '127.0.0.1'

// The bot ws (unchanged Gemini Live bot). Gateway connects as a CLIENT per call.
const BOT_WS_URL = process.env.SIP_BOT_WS_URL || process.env.NGS_LIVE_WS_URL || 'ws://127.0.0.1:8766/ws'
// Base URL the bot should hit for hang-up/transfer control (this gateway). Injected
// into the bot's start-frame params as `ctrl`. Defaults to our own localhost control API.
const CTRL_BASE = (process.env.SIP_GATEWAY_CTRL_BASE || `http://127.0.0.1:${CTRL_PORT}`).replace(/\/$/, '')
// Optional per-call token secret (owner rule: only OUR calls open the bot ws).
const INTERNAL_TOKEN = process.env.AGENT_INTERNAL_TOKEN || ''
// Phase 2 (inbound): where to ask who the caller is + which persona answers. Our own
// Next.js route (sip-inbound) owns owner-recognition, the DB row and the DID→persona map.
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '')
const SIP_INBOUND_SECRET = process.env.SIP_INBOUND_SECRET || process.env.NGS_INBOUND_SECRET || ''
const INBOUND_VOICE = process.env.SIP_INBOUND_VOICE || process.env.NGS_INBOUND_VOICE || 'Charon'

const ARI_READY = Boolean(ARI_USER && ARI_PASS)

// ── AudioSocket frame constants ──────────────────────────────────────────────
const AS_TYPE_TERMINATE = 0x00
const AS_TYPE_UUID = 0x01
const AS_TYPE_ERROR = 0xff
const AS_TYPE_AUDIO = 0x10

const log = (...a) => console.log('[sip-gw]', ...a)

// ── ARI REST helper ──────────────────────────────────────────────────────────
function ariAuthHeader() {
  return 'Basic ' + Buffer.from(`${ARI_USER}:${ARI_PASS}`).toString('base64')
}
async function ari(method, path, query) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : ''
  const res = await fetch(`${ARI_BASE}/ari${path}${qs}`, {
    method,
    headers: { Authorization: ariAuthHeader() },
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text().catch(() => '')
  let json
  try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text } }
  if (!res.ok) throw new Error(`ARI ${method} ${path} -> ${res.status} ${text.slice(0, 160)}`)
  return json
}

// ── per-call state ───────────────────────────────────────────────────────────
/** callId (ARI channel id) -> Call */
const calls = new Map()
/** audiosocket uuid -> Call */
const byUuid = new Map()

// Phase 3 — per-call CDR. Once a channel is gone ARI can tell us nothing about it, but the
// outcome sweep still needs to know WHY a call never connected (busy vs nobody answered vs
// failed) to report it honestly to the owner. So we keep a small ring of finished calls.
const CDR_MAX = Number(process.env.SIP_CDR_MAX || 500)
/** callId -> {call_id, direction, to, answered, startedAt, answeredAt, endedAt, cause, causeTxt, status} */
const cdr = new Map()
function putCdr(id, patch) {
  if (!id) return
  const prev = cdr.get(id) || { call_id: id }
  cdr.set(id, { ...prev, ...patch })
  // Map.keys() is insertion-ordered, so the oldest entry is always first.
  while (cdr.size > CDR_MAX) cdr.delete(cdr.keys().next().value)
}
/**
 * Push a finished call's record to the app so it survives this process. The in-memory ring
 * is lost on every restart, which would take call history, outcomes and cost with it — and
 * for a TRANSFERRED call this is the only trace that exists at all, because the bot steps
 * off the audio path and never sees how the two humans' conversation went.
 */
async function persistCdr(id) {
  const rec = cdr.get(id)
  if (!rec || !APP_URL || !INTERNAL_TOKEN || rec._persisted) return
  // Wait for the recording upload; finishRecording() calls back here when it is done.
  if (rec._pendingRecording) return
  rec._persisted = true
  try {
    const res = await fetch(`${APP_URL}/api/assistant/voice-call/sip-cdr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INTERNAL_TOKEN}` },
      body: JSON.stringify({ ...rec, _pendingRecording: undefined, _persisted: undefined }),
      signal: AbortSignal.timeout(10_000),
    })
    // Log non-2xx too: a call record that silently fails to persist looks identical to one
    // that was never attempted, and this is the only copy of a transferred call's outcome.
    if (!res.ok) log(id, `cdr persist HTTP ${res.status}`)
  } catch (err) { log(id, 'cdr persist failed:', err?.message) }
}

/**
 * Put a finished recording in Supabase and return a URL the owner can open.
 * Signed for a long window rather than made public: a phone call is private business
 * content, so the link should be shareable with him without making the bucket readable.
 */
async function uploadRecording(name, buf) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) { log('recording upload skipped: Supabase env missing'); return null }
  const path = `calls/recordings/${name}.wav`
  try {
    const put = await fetch(`${url.replace(/\/$/, '')}/storage/v1/object/agent-files/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'audio/wav', 'x-upsert': 'true' },
      body: buf,
      signal: AbortSignal.timeout(60_000),
    })
    if (!put.ok) { log(`recording upload HTTP ${put.status}`); return null }
    const signed = await fetch(`${url.replace(/\/$/, '')}/storage/v1/object/sign/agent-files/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: Number(process.env.SIP_RECORDING_LINK_DAYS || 30) * 86400 }),
      signal: AbortSignal.timeout(20_000),
    })
    const data = await signed.json().catch(() => ({}))
    if (!data?.signedURL) { log('recording sign failed'); return null }
    return `${url.replace(/\/$/, '')}/storage/v1${data.signedURL}`
  } catch (err) { log('recording upload failed:', err?.message); return null }
}

/**
 * Turn an ISDN hangup cause into the outcome vocabulary the rest of the system already
 * speaks (same words the NGS path reports). Answered calls are 'completed' regardless of
 * cause — the bot's own post-call report carries the substance.
 */
function outcomeFromCause(answered, cause) {
  if (answered) return 'completed'
  switch (Number(cause)) {
    case 17: return 'busy'                    // user busy
    case 18: case 19: case 21: return 'no_answer' // no user responding / no answer / rejected
    default: return 'failed'
  }
}

// Cost + abuse guard: a runaway loop (or a stolen control-API key) must not be able to
// dial dozens of PSTN legs. Owner-tunable; refuses politely past the cap.
const MAX_CONCURRENT = Number(process.env.SIP_MAX_CONCURRENT_CALLS || 4)
// Only these destinations may be dialled (BD mobile/landline in local or +880 form).
const DEST_ALLOW = new RegExp(process.env.SIP_DEST_ALLOW || '^(0\\d{9,10}|880\\d{9,10})$')
// Hourly originate ceiling across the whole gateway.
const MAX_PER_HOUR = Number(process.env.SIP_MAX_CALLS_PER_HOUR || 30)
const recentOriginates = []
let authFailures = 0
let lastAuthAlert = 0
// Where one-way message audio is staged for Asterisk to play (must be readable by Asterisk).
const PLAY_DIR = process.env.SIP_PLAY_DIR || tmpdir()
// One 20 ms slin frame of silence, used to keep the AudioSocket stream continuous while
// the model is not speaking (see startPlayout).
const SILENCE_FRAME = Buffer.alloc(320)
// Byte-level capture of exactly what we hand Asterisk and what we get back (SIP_DEBUG_RECORD=1).
// Recording at the ARI bridge returned 500 on this build, and capturing here is better anyway:
// it isolates OUR pipeline, so a reported glitch can be shown to be present (our fault) or
// absent (introduced downstream on the PSTN leg) instead of argued about.
const DEBUG_RECORD = process.env.SIP_DEBUG_RECORD === '1'

// Call recording (owner requirement 2026-07-25). On by default so nothing is silently
// missed; SIP_RECORD_CALLS=0 turns it off. Bounded so a stuck call cannot fill the disk.
const RECORD_CALLS = process.env.SIP_RECORD_CALLS !== '0'
const RECORD_MAX_SECS = Number(process.env.SIP_RECORD_MAX_SECS || 1800)
const RECORD_DIR = process.env.SIP_RECORD_DIR || '/var/spool/asterisk/recording'

// Voicemail safety net. If the AI cannot take an inbound call — Gemini session refused, the
// bot process down, the kill switch off — the caller would otherwise get an answered line and
// dead air. Instead we play a Bangla prompt, record what they say and tell the owner.
const VOICEMAIL_ENABLED = process.env.SIP_VOICEMAIL_ENABLED !== '0'
const VOICEMAIL_PROMPT = process.env.SIP_VOICEMAIL_PROMPT || '/var/lib/asterisk/sounds/alma-voicemail'
const VOICEMAIL_AFTER_SECS = Number(process.env.SIP_VOICEMAIL_AFTER_SECS || 8)
const VOICEMAIL_MAX_SECS = Number(process.env.SIP_VOICEMAIL_MAX_SECS || 120)

// Length of the barge-in fade, in 20 ms frames. Two frames (40 ms) is long enough to be
// click-free and short enough that the caller still experiences an immediate interruption.
const FADE_FRAMES = Number(process.env.SIP_BARGE_FADE_FRAMES || 2)
// How much audio to hold before playing, in 20 ms frames. Small enough not to add
// noticeable delay, large enough to ride out the bot's event-loop stalls.
const JITTER_FRAMES = Number(process.env.SIP_JITTER_FRAMES || 8)

/** Ease a frame up from digital zero, for the first audio after a silent gap. */
function fadeInFrame(f) {
  const n = f.length >> 1
  const out = Buffer.allocUnsafe(f.length)
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(f.readInt16LE(i * 2) * ((i + 1) / n)), i * 2)
  return out
}

/** One frame that eases from `from` down to digital zero, so audio never stops on a step. */
function rampToZero(from) {
  if (!from) return SILENCE_FRAME
  const out = Buffer.allocUnsafe(320)
  for (let i = 0; i < 160; i++) out.writeInt16LE(Math.round(from * (1 - (i + 1) / 160)), i * 2)
  return out
}

/** Apply a linear fade to zero across the given slin frames (returns new buffers). */
function fadeOutFrames(frames) {
  const total = frames.reduce((n, f) => n + (f.length >> 1), 0)
  if (!total) return []
  let idx = 0
  return frames.map((f) => {
    const n = f.length >> 1
    const out = Buffer.allocUnsafe(f.length)
    for (let i = 0; i < n; i++, idx++) {
      const gain = 1 - idx / total
      out.writeInt16LE(Math.round(f.readInt16LE(i * 2) * gain), i * 2)
    }
    return out
  })
}
/**
 * How long to let the callee's phone ring, in seconds. ARI's default is 30, which is too
 * short in practice — live 2026-07-25: the owner reached his phone at ~30s, by which time we
 * had already cancelled, so the CARRIER answered him with "the number you're calling is busy"
 * and cut. Both failed calls ended at exactly 30.000s with hangup cause 0 (our own cancel),
 * which is what identified it. 45s matches the Twilio path's Timeout.
 */
const RING_TIMEOUT = Number(process.env.SIP_RING_TIMEOUT || 45)
// How long to stay on the line waiting for a keypress after a confirmation message.
const CONFIRM_WAIT_SECS = Number(process.env.SIP_CONFIRM_WAIT_SECS || 12)

class Call {
  constructor(channelId, params) {
    this.channelId = channelId          // = call_id in the control API + ARI channel id
    this.params = params || {}          // { id, exp, t, purpose, recipientName, voice, callType }
    this.audioUuid = randomUUID()       // externalMedia AudioSocket connection id
    this.bridgeId = null
    this.extChannelId = null            // externalMedia (AudioSocket) channel
    this.asSocket = null                // Asterisk's AudioSocket TCP connection
    this.bot = null                     // ws to the Gemini Live bot
    this.botReady = false
    this.playQueue = []                 // 320-byte slin frames -> Asterisk, drained at 20ms
    this.playTimer = null
    this.slinResidual = Buffer.alloc(0) // partial slin frame from the bot side
    this.answered = false
    this.closed = false
    this.transferring = false
    this.playOnly = false               // one-way message call: play a file, then hang up
    this.playUrl = ''
    this.playFile = ''
    this.voicemail = false              // AI unavailable -> taking a message instead
    this.vmTimer = null
    this.vmName = null
    this.vmPromptTimer = null
    this.collectDigits = false          // wait for a keypress after the message (confirmation)
    this.digit = null                   // what the receiver actually pressed
    this.digitTimer = null
    this.confirmCallbackUrl = ''        // where to POST the confirmation result
    this.confirmRef = ''                // caller-supplied id echoed back with the result
    byUuid.set(this.audioUuid, this)
  }

  // ── bot ws (NGS dialect) ───────────────────────────────────────────────────
  connectBot() {
    let ws
    try { ws = new WebSocket(BOT_WS_URL) } catch (e) { log(this.channelId, 'bot ws create err', e?.message); return }
    this.bot = ws
    ws.on('open', () => {
      this.botReady = true
      // NGS-shaped start frame. streamId TOP-LEVEL + call_id => bot reads transport
      // as ngs-family; we add `ctrl` so hang-up/transfer target THIS gateway, not NGS.
      const params = { ...this.params, ctrl: CTRL_BASE }
      this.send({ event: 'start', streamId: this.channelId, call_id: this.channelId, params })
      log(this.channelId, 'bot ws open -> start sent')
    })
    ws.on('message', (raw) => this.onBot(raw))
    ws.on('close', () => {
      this.botReady = false
      if (this.closed || this.transferring || this.voicemail) return
      // An INBOUND caller must never be hung up on because our AI is unavailable — that is
      // precisely when a message should be taken instead. (Live self-test 2026-07-25: with the
      // bot stopped, the ws closed immediately and the call was dropped before the voicemail
      // watchdog could even fire.) Outbound calls we placed simply end.
      if (VOICEMAIL_ENABLED && this.inbound) { void this.startVoicemail(); return }
      this.hangup('bot ws closed')
    })
    ws.on('error', (e) => log(this.channelId, 'bot ws err', e?.message))
  }

  send(obj) {
    if (this.bot && this.bot.readyState === WebSocket.OPEN) {
      try { this.bot.send(JSON.stringify(obj)) } catch { /* */ }
    }
  }

  // Bot -> gateway: NGS-shaped media/clear frames (μ-law 8k base64).
  onBot(raw) {
    let m
    try { m = JSON.parse(raw.toString()) } catch { return }
    if (m.event === 'media' && m.media?.payload) {
      const mu = Buffer.from(m.media.payload, 'base64')
      this.enqueueAudio(muLawToPcm16(mu)) // μ-law -> slin8k -> 20ms playout queue -> AudioSocket
    } else if (m.event === 'clear') {
      // Native barge-in: the model stopped talking because the caller started, so the
      // queued audio must go. Dropping it INSTANTLY cuts the waveform mid-cycle, and a
      // step discontinuity in a speaker is a click — the owner heard exactly that and
      // described it as "শিস করে শব্দ কেটে যাচ্ছে" (live 2026-07-25). Fading the last few
      // milliseconds to zero ends the audio silently instead. The interruption itself is
      // still immediate; only the click goes away.
      this.barges = (this.barges || 0) + 1
      this.playQueue = fadeOutFrames(this.playQueue.slice(0, FADE_FRAMES))
      this.slinResidual = Buffer.alloc(0)
    }
  }

  // ── AudioSocket (Asterisk externalMedia) ───────────────────────────────────
  attachAudioSocket(socket) {
    this.asSocket = socket
    this.startPlayout()
  }

  /**
   * Continuous 20 ms playout with SILENCE FILL.
   *
   * AudioSocket is a real-time stream: Asterisk expects a frame every 20 ms for as long as
   * the channel is up. The bot, however, only produces audio while the model is speaking and
   * goes quiet between turns (its jitter buffer even re-buffers ~120 ms before resuming). So
   * simply forwarding what the bot sends leaves holes in the stream at the END of every
   * utterance — which the owner heard exactly that way: "প্রতিটা বাক্যের শেষে একটু হ্যাং হয়ে
   * যায়, শেষ শব্দটা শেষ হয় না, একটা শব্দ হয়" (2026-07-25, live).
   *
   * Filling the gaps with silence keeps the stream unbroken, so the channel never underruns
   * and the tail of each sentence lands intact. Pacing is CLOCK-scheduled (a target
   * timestamp, not one frame per timer tick) because setInterval fires late and
   * one-frame-per-tick would drift slower than real time, building a backlog all call.
   */
  startPlayout() {
    if (this.playTimer) return
    this.nextFrameAt = Date.now()
    this.rebuffering = true
    this.playTimer = setInterval(() => {
      if (this.closed || !this.asSocket || this.asSocket.destroyed) return
      const now = Date.now()
      // Catch up if we fell behind (event-loop stall), but never run away.
      let guard = 0
      while (now >= this.nextFrameAt && guard < 50) {
        // Jitter cushion: the bot paces its own output, but its event loop stalls whenever
        // it is busy (model events, ERP tool calls), so frames arrive in gusts. With no
        // cushion this queue ran dry mid-sentence — measured 8 times in one 109 s call —
        // and the caller heard the voice stall and then click back in. Hold a small buffer
        // before starting, and rebuild it after a dry spell, exactly as the bot does.
        if (this.rebuffering) {
          if (this.playQueue.length >= JITTER_FRAMES) this.rebuffering = false
          else { this.rawWriteAudio(SILENCE_FRAME); this.silenceFrames = (this.silenceFrames || 0) + 1; this.nextFrameAt += 20; guard++; continue }
        }
        const frame = this.playQueue.shift()
        if (frame) this.rawWriteAudio(this.fadeIn ? fadeInFrame(frame) : frame)
        else {
          // Silence between turns is expected; silence RIGHT AFTER audio means the queue ran
          // dry mid-utterance, which is exactly what a listener hears as the voice breaking.
          // Either way, jumping straight from a mid-waveform sample to digital zero is a step
          // discontinuity — a click in the earpiece. Ease the first silent frame down from
          // wherever the audio stopped instead.
          if (this.lastWasAudio) {
            this.underruns = (this.underruns || 0) + 1
            this.rawWriteAudio(rampToZero(this.lastSample))
            this.rebuffering = true // wait for the cushion again instead of stuttering
          } else {
            this.rawWriteAudio(SILENCE_FRAME)
          }
          this.silenceFrames = (this.silenceFrames || 0) + 1
        }
        // Coming back from silence, starting mid-waveform is the same step discontinuity in
        // reverse — so the first frame after a gap eases in.
        this.fadeIn = !frame
        if (frame) this.lastSample = frame.readInt16LE(frame.length - 2)
        this.lastWasAudio = Boolean(frame)
        this.nextFrameAt += 20
        guard++
      }
    }, 10)
  }

  // Asterisk -> gateway: slin8k audio -> μ-law -> bot media frame.
  onAsteriskAudio(slin) {
    if (this.rxFd) this.rxFd.write(slin)
    if (!this.botReady) return
    const mu = pcm16ToMuLaw(slin)
    this.send({ event: 'media', streamId: this.channelId, media: { payload: mu.toString('base64') } })
  }

  // Cut the bot's slin into steady 20ms (320-byte) frames and enqueue for paced playout.
  enqueueAudio(slin) {
    const buf = Buffer.concat([this.slinResidual, slin])
    const FRAME = 320 // 20ms slin @ 8k
    let off = 0
    for (; off + FRAME <= buf.length; off += FRAME) {
      this.framesOut = (this.framesOut || 0) + 1
      this.playQueue.push(buf.subarray(off, off + FRAME))
    }
    this.slinResidual = buf.subarray(off)
    // Safety net only: with clock-scheduled playout the queue should never build up, so if
    // this ever fires it means we are falling behind real time — log it instead of silently
    // deleting the caller's audio, because dropped frames are exactly what "the voice keeps
    // sticking" sounds like.
    if (this.playQueue.length > 500) {
      const dropped = this.playQueue.length - 500
      this.playQueue.splice(0, dropped)
      this.dropped = (this.dropped || 0) + dropped
      log(this.channelId, `playout OVERRUN — dropped ${dropped} frames (${this.dropped} total)`)
    }
  }
  /** Open raw slin8k dumps for this call (debug only). */
  openCapture() {
    try {
      this.txFile = `${PLAY_DIR}/dbg-${this.channelId}-tx.raw`
      this.rxFile = `${PLAY_DIR}/dbg-${this.channelId}-rx.raw`
      this.txFd = createWriteStream(this.txFile)
      this.rxFd = createWriteStream(this.rxFile)
      log(this.channelId, `debug capture -> ${this.txFile}`)
    } catch (err) { log(this.channelId, 'capture open failed:', err?.message) }
  }

  rawWriteAudio(payload) {
    if (this.txFd) this.txFd.write(payload)
    if (!this.asSocket || this.asSocket.destroyed) return
    const hdr = Buffer.allocUnsafe(3)
    hdr[0] = AS_TYPE_AUDIO
    hdr.writeUInt16BE(payload.length, 1)
    try { this.asSocket.write(Buffer.concat([hdr, payload])) } catch { /* */ }
  }

  /**
   * Stop the recording, hand the audio to Supabase and put the URL on the call record.
   * Runs before the CDR is persisted so the owner's report carries the link.
   */
  async finishRecording() {
    const name = this.recordingName
    this.recordingName = null
    // Asterisk finalises the file when the recording stops; the bridge usually dies first,
    // which stops it anyway, so a 404 here is normal rather than an error.
    await ari('POST', `/recordings/live/${encodeURIComponent(name)}/stop`).catch(() => {})
    const file = `${RECORD_DIR}/${name}.wav`
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const buf = await readFile(file)
        // A near-empty WAV is a call where nothing was ever said — not worth storing.
        if (buf.length > 8000) {
          const url = await uploadRecording(name, buf)
          if (url) {
            const secs = Math.max(0, Math.round((buf.length - 44) / (8000 * 2)))
            putCdr(this.channelId, { recordingUrl: url, recordingSecs: secs })
            log(this.channelId, `recording stored (${secs}s)`)
          }
        }
        await unlink(file).catch(() => {})
        putCdr(this.channelId, { _pendingRecording: false })
        await persistCdr(this.channelId)
        return
      } catch {
        await new Promise((r) => setTimeout(r, 400)) // still being flushed
      }
    }
    log(this.channelId, 'recording file never appeared:', file)
    putCdr(this.channelId, { _pendingRecording: false })
    await persistCdr(this.channelId)
  }

  /**
   * A caller must never sit on an answered line hearing nothing. If no audio has come back
   * from the bot within VOICEMAIL_AFTER_SECS, treat the AI as unavailable and take a message
   * instead — dead air loses a customer, a recorded message does not.
   */
  armVoicemailFallback() {
    if (!VOICEMAIL_ENABLED) return
    this.vmTimer = setTimeout(() => {
      if (this.closed || this.voicemail) return
      if ((this.framesOut || 0) > 25) return // the bot is talking; nothing is wrong
      log(this.channelId, `no bot audio in ${VOICEMAIL_AFTER_SECS}s — falling back to voicemail`)
      void this.startVoicemail()
    }, VOICEMAIL_AFTER_SECS * 1000)
  }

  /** Take the AI off the line and play the prompt; recording starts on PlaybackFinished. */
  async startVoicemail() {
    if (this.voicemail || this.closed) return
    this.voicemail = true
    try { this.bot?.close() } catch { /* */ }
    this.botReady = false
    this.playQueue.length = 0
    if (this.playTimer) { clearInterval(this.playTimer); this.playTimer = null }
    try {
      // Drop the media leg first, or our silence fill would play over the prompt.
      if (this.extChannelId) await ari('DELETE', `/channels/${this.extChannelId}`).catch(() => {})
      this.extChannelId = null
      // Everything stays BRIDGE-scoped from here. Taking the caller out of the bridge was
      // tried first and does not work: both destroying the bridge and removeChannel eject the
      // channel out of Stasis into the dialplan's Hangup, after which play returns "Channel
      // not found" (live self-test 2026-07-25). Playing and recording on the bridge is the
      // same path the call recording already proved.
      await ari('POST', `/bridges/${this.bridgeId}/play`, { media: `sound:${VOICEMAIL_PROMPT}` })
      log(this.channelId, 'voicemail prompt playing')
      // Backstop: a missing event must never leave the caller sitting in silence. If the
      // recording has not started by the time the prompt could possibly have ended, start it.
      this.vmPromptTimer = setTimeout(() => {
        if (!this.closed && !this.vmName) {
          log(this.channelId, 'PlaybackFinished never arrived — starting recording anyway')
          void this.recordVoicemail()
        }
      }, Number(process.env.SIP_VOICEMAIL_PROMPT_SECS || 20) * 1000)
    } catch (err) {
      log(this.channelId, 'voicemail prompt failed:', err?.message)
      void this.hangup('voicemail prompt failed')
    }
  }

  /** Record the caller's message; RecordingFinished delivers it. */
  async recordVoicemail() {
    this.vmName = `vm-${this.channelId}`
    try {
      await ari('POST', `/bridges/${this.bridgeId}/record`, {
        name: this.vmName, format: 'wav', maxDurationSeconds: String(VOICEMAIL_MAX_SECS),
        maxSilenceSeconds: '5', ifExists: 'overwrite', beep: 'false',
      })
      log(this.channelId, 'voicemail recording')
    } catch (err) {
      log(this.channelId, 'voicemail record failed:', err?.message)
      void this.hangup('voicemail record failed')
    }
  }

  /** Upload the message and tell the owner who called. */
  async deliverVoicemail() {
    const name = this.vmName
    this.vmName = null
    if (!name) return
    const file = `${RECORD_DIR}/${name}.wav`
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const buf = await readFile(file)
        const secs = Math.max(0, Math.round((buf.length - 44) / (8000 * 2)))
        // Under ~2 s is someone hanging up on the beep, not a message worth forwarding.
        if (buf.length > 32000) {
          const url = await uploadRecording(name, buf)
          if (url && APP_URL && INTERNAL_TOKEN) {
            await fetch(`${APP_URL}/api/assistant/voice-call/sip-voicemail`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INTERNAL_TOKEN}` },
              body: JSON.stringify({ caller: this.params?.caller || '', did: this.params?.did || '', url, secs }),
              signal: AbortSignal.timeout(15_000),
            }).catch((err) => log(this.channelId, 'voicemail notify failed:', err?.message))
            log(this.channelId, `voicemail delivered (${secs}s)`)
          }
        } else {
          log(this.channelId, 'voicemail too short — discarded')
        }
        await unlink(file).catch(() => {})
        return
      } catch { await new Promise((r) => setTimeout(r, 400)) }
    }
    log(this.channelId, 'voicemail file never appeared:', file)
  }

  // ── keypress confirmation (one-way calls) ──────────────────────────────────
  /**
   * The message has finished playing and we asked the receiver to press a key. Stay on the
   * line for a bounded window — hanging up immediately would make confirmation impossible,
   * and staying forever would burn call minutes on someone who walked away.
   */
  awaitDigit() {
    if (this.digitTimer || this.closed) return
    log(this.channelId, `awaiting keypress (${CONFIRM_WAIT_SECS}s)`)
    this.digitTimer = setTimeout(() => {
      if (this.closed || this.digit) return
      log(this.channelId, 'no keypress — timed out')
      void this.finishConfirm('timeout')
    }, CONFIRM_WAIT_SECS * 1000)
  }

  async onDigit(digit) {
    if (!digit || this.digit) return
    this.digit = digit
    log(this.channelId, `keypress: ${digit}`)
    await this.finishConfirm('pressed')
  }

  /** Record the answer, tell whoever asked for it, then end the call. */
  async finishConfirm(how) {
    if (this.digitTimer) { clearTimeout(this.digitTimer); this.digitTimer = null }
    const result = {
      call_id: this.channelId,
      ref: this.confirmRef || null,
      digit: this.digit,
      // 'confirmed' / 'declined' are just the conventional meanings of 1 and 2; any other
      // key is reported verbatim so the caller can define its own mapping later.
      outcome: this.digit === '1' ? 'confirmed' : this.digit === '2' ? 'declined' : how === 'timeout' ? 'no_response' : 'other',
      answeredAt: cdr.get(this.channelId)?.answeredAt ?? null,
    }
    putCdr(this.channelId, { digit: this.digit, confirmOutcome: result.outcome })
    if (this.confirmCallbackUrl) {
      try {
        await fetch(this.confirmCallbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(INTERNAL_TOKEN ? { Authorization: `Bearer ${INTERNAL_TOKEN}` } : {}) },
          body: JSON.stringify(result),
          signal: AbortSignal.timeout(10_000),
        })
      } catch (err) { log(this.channelId, 'confirm callback failed:', err?.message) }
    }
    await this.hangup(`confirm ${result.outcome}`)
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  async hangup(reason) {
    if (this.closed) return
    this.closed = true
    log(this.channelId, 'hangup', reason ? `(${reason})` : '',
      `| audio frames=${this.framesOut || 0} silence=${this.silenceFrames || 0} underruns=${this.underruns || 0} barge-ins=${this.barges || 0} dropped=${this.dropped || 0}`)
    if (this.playTimer) { clearInterval(this.playTimer); this.playTimer = null }
    try { this.txFd?.end(); this.rxFd?.end() } catch { /* */ }
    if (this.digitTimer) { clearTimeout(this.digitTimer); this.digitTimer = null }
    if (this.vmTimer) { clearTimeout(this.vmTimer); this.vmTimer = null }
    if (this.vmPromptTimer) { clearTimeout(this.vmPromptTimer); this.vmPromptTimer = null }
    try { this.asSocket?.end() } catch { /* */ }
    // End the PSTN leg + tidy the bridge/externalMedia via ARI.
    try { if (this.extChannelId) await ari('DELETE', `/channels/${this.extChannelId}`).catch(() => {}) } catch { /* */ }
    try { await ari('DELETE', `/channels/${this.channelId}`).catch(() => {}) } catch { /* */ }
    try { if (this.bridgeId) await ari('DELETE', `/bridges/${this.bridgeId}`).catch(() => {}) } catch { /* */ }
    if (this.playFile) await unlink(this.playFile).catch(() => {})
    if (this.vmName) await this.deliverVoicemail()
    if (this.recordingName) await this.finishRecording()
    // Closed LAST: closing it is what makes the bot send its post-call report, and by now the
    // recording is already on the record, so that report can carry the link.
    try { this.bot?.close() } catch { /* */ }
    calls.delete(this.channelId)
    byUuid.delete(this.audioUuid)
  }
}

// ── AudioSocket TCP server ───────────────────────────────────────────────────
// Frame = 1 byte type + 2 bytes BE length + payload. ID frame (0x01) carries the
// 16-byte UUID we set as externalMedia `data`; we use it to bind socket -> Call.
function uuidFromBytes(b) {
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
const audioServer = net.createServer((socket) => {
  socket.setNoDelay(true)
  let buf = Buffer.alloc(0)
  let call = null
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    // parse as many complete frames as present
    while (buf.length >= 3) {
      const type = buf[0]
      const len = buf.readUInt16BE(1)
      if (buf.length < 3 + len) break
      const payload = buf.subarray(3, 3 + len)
      buf = buf.subarray(3 + len)
      if (type === AS_TYPE_UUID && len === 16) {
        const uuid = uuidFromBytes(payload)
        call = byUuid.get(uuid) || null
        if (call) { call.attachAudioSocket(socket); log(call.channelId, 'AudioSocket attached', uuid) }
        else log('AudioSocket UUID with no matching call', uuid)
      } else if (type === AS_TYPE_AUDIO) {
        if (call) call.onAsteriskAudio(Buffer.from(payload)) // slin8k
      } else if (type === AS_TYPE_TERMINATE) {
        if (call && !call.voicemail) void call.hangup('audiosocket terminate')
        socket.end()
      } else if (type === AS_TYPE_ERROR) {
        log(call?.channelId || '?', 'AudioSocket error frame')
      }
    }
  })
  socket.on('close', () => {
    // In voicemail mode we deliberately delete the externalMedia channel, which closes this
    // socket — hanging the caller up here would end the call before the prompt even finished
    // (that is exactly what silently killed the first voicemail attempts, 2026-07-25).
    if (call && !call.closed && !call.voicemail) void call.hangup('audiosocket closed')
  })
  socket.on('error', (e) => log('audiosocket err', e?.message))
})

// ── ARI events (WebSocket) ───────────────────────────────────────────────────
function startAri() {
  if (!ARI_READY) { log('ARI not configured (ARI_USER/ARI_PASS unset) — control API will 503, no crash'); return }
  const wsUrl = ARI_BASE.replace(/^http/, 'ws') +
    `/ari/events?api_key=${encodeURIComponent(ARI_USER)}:${encodeURIComponent(ARI_PASS)}` +
    `&app=${encodeURIComponent(ARI_APP)}&subscribeAll=false`
  let ws
  try { ws = new WebSocket(wsUrl) } catch (e) { log('ARI ws create err', e?.message); return void setTimeout(startAri, 3000) }
  ws.on('open', () => log(`ARI events connected (app=${ARI_APP})`))
  ws.on('message', (raw) => { let e; try { e = JSON.parse(raw.toString()) } catch { return } void onAriEvent(e) })
  ws.on('close', () => { log('ARI events closed — reconnecting in 3s'); setTimeout(startAri, 3000) })
  ws.on('error', (e) => log('ARI events err', e?.message))
}

// Wire an answered channel to the bot: mixing bridge + externalMedia(AudioSocket) + bot ws.
// Shared by the outbound path (channel answers, enters Stasis) and the inbound path
// (call arrives from the trunk, we answer it, then wire the same way).
async function bridgeAndStartBot(call) {
  // 1) mixing bridge
  const bridge = await ari('POST', '/bridges', { type: 'mixing' })
  call.bridgeId = bridge.id
  // 2) externalMedia (AudioSocket, TCP, Asterisk = client) -> our AS server
  const ext = await ari('POST', '/channels/externalMedia', {
    app: ARI_APP,
    external_host: `${AS_ADVERTISE}:${AS_PORT}`,
    encapsulation: 'audiosocket',
    transport: 'tcp',
    connection_type: 'client',
    format: 'slin',
    direction: 'both',
    data: call.audioUuid,
  })
  call.extChannelId = ext.id
  // 3) bridge the PSTN leg + the media leg
  await ari('POST', `/bridges/${call.bridgeId}/addChannel`, { channel: `${call.channelId},${call.extChannelId}` })
  // 4) open the bot ws now that audio can flow
  call.connectBot()
  // Debug capture (SIP_DEBUG_RECORD=1): record the bridge so a reported glitch can be
  // measured instead of guessed at — it shows whether the damage is already present in what
  // Asterisk played toward the caller (our side) or only reaches the caller's ear (the PSTN
  // leg). Off by default; recordings stay on the VPS.
  if (DEBUG_RECORD) call.openCapture()
  // Record the BRIDGE, not our media leg: the bridge keeps recording after a transfer, when
  // the AI has stepped off the audio path — the one stretch of a call nobody could account
  // for before. Asterisk writes to /var/spool/asterisk/recording (created 2026-07-25; its
  // absence was why ARI recording returned 500).
  if (RECORD_CALLS) {
    call.recordingName = `alma-${call.channelId}`
    // The channel dies before the upload finishes, so without this the record would be
    // persisted first and the recording link would never reach the owner's report.
    putCdr(call.channelId, { _pendingRecording: true })
    ari('POST', `/bridges/${call.bridgeId}/record`, {
      name: call.recordingName, format: 'wav', ifExists: 'overwrite', beep: 'false',
      maxDurationSeconds: String(RECORD_MAX_SECS),
    }).then(() => log(call.channelId, 'recording started'))
      .catch((err) => {
        call.recordingName = null
        putCdr(call.channelId, { _pendingRecording: false })
        log(call.channelId, 'recording failed:', err?.message)
      })
  }
  log(call.channelId, 'bridged externalMedia', call.extChannelId)
}

/**
 * ONE-WAY message call (Phase 3, the NGS <Play> replacement). ARI can only play media it
 * can reach locally — `sound:` URIs, not HTTP — so we fetch the caller's audio URL (a
 * Supabase signed URL in practice) to a temp file and play that, then hang up when the
 * PlaybackFinished event arrives. Asterisk resolves `sound:/path/foo` without the
 * extension, so the file is written as .wav and referenced extensionless.
 */
async function playAndHangup(call) {
  const file = `${PLAY_DIR}/alma-play-${call.channelId}`
  try {
    const res = await fetch(call.playUrl, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`fetch audio ${res.status}`)
    await writeFile(`${file}.wav`, Buffer.from(await res.arrayBuffer()))
    call.playFile = `${file}.wav`
    await ari('POST', `/channels/${call.channelId}/play`, { media: `sound:${file}` })
    log(call.channelId, 'one-way playback started')
  } catch (err) {
    log(call.channelId, 'one-way playback failed:', err?.message)
    void call.hangup('playback failed')
  }
}

/**
 * INBOUND (Phase 2) — the caller-ID win. Somebody dialed our DID; the trunk sent an
 * INVITE to our Asterisk, the from-alma dialplan handed it to Stasis, and the ARI event
 * carries the REAL caller number in `channel.caller.number` (the field NGS stripped, which
 * is why "জি বস" owner-recognition never worked on NGS).
 *
 * We ask our own Next.js route who this is (owner vs customer), get back the persona +
 * a signed bot token + the DB row id, then answer and wire the same bridge as outbound.
 * If the app is unreachable we STILL answer with a generic assistant persona and a
 * self-minted token — a customer's call must never drop because Vercel hiccuped.
 */
async function onInboundCall(e) {
  const chanId = e.channel?.id
  // Dialplan hands us Stasis(alma-sip,inbound,<callerid>,<did>). Prefer the channel's own
  // caller field, and take the DID from the args — `dialplan.exten` is 's' by then because
  // from-alma routes through a shared handler, which would break the multi-DID persona map.
  const args = e.args || []
  const caller = normalizeCaller(e.channel?.caller?.number || args[1] || '')
  const did = String(args[2] || e.channel?.dialplan?.exten || '').trim()
  log(chanId, `INBOUND from=${caller || 'unknown'} did=${did || '-'}`)
  let params = await fetchInboundParams(caller, did)
  if (!params) {
    // Fail-safe persona: answer with a locally-signed token so the bot accepts the media
    // session. No DB row -> the post-call report has no target, which is a far smaller loss
    // than dropping the caller. Owner-recognition still applies locally (OWNER_PHONE_NUMBERS)
    // so the boss never gets the receptionist just because the app was unreachable.
    const id = 'sipin-' + randomUUID()
    const exp = Date.now() + 15 * 60_000
    const owner = isOwnerCaller(caller)
    params = {
      id, exp,
      t: INTERNAL_TOKEN ? createHmac('sha256', INTERNAL_TOKEN).update(`relay:${id}:${exp}`).digest('hex') : '',
      purpose: owner
        ? 'Boss নিজে ফোন করেছেন — সালাম দিয়ে জিজ্ঞেস করো কী লাগবে।'
        : 'ইনকামিং কল — ব্যবসার সহকারী হিসেবে সাহায্য করো এবং কী দরকার জেনে নাও',
      recipientName: owner ? 'Boss' : (caller || ''),
      voice: INBOUND_VOICE,
      callType: owner ? 'owner' : 'inbound',
      // Human transfer must keep working on the fallback path too — a customer who asks for
      // a person should still reach the support line when the app is unreachable.
      forwardSupport: process.env.SIP_FORWARD_SUPPORT || '',
      forwardBoss: process.env.SIP_FORWARD_BOSS || process.env.NGS_FORWARD_NUMBER || '',
    }
    log(chanId, `inbound params fallback (app unreachable) owner=${owner ? 'y' : 'n'}`)
  }
  const call = new Call(chanId, { ...params, caller, did })
  call.inbound = true
  calls.set(chanId, call)
  try {
    await ari('POST', `/channels/${chanId}/answer`)
    call.answered = true
    call.answeredAt = Date.now()
    putCdr(chanId, { direction: 'inbound', from: caller, did, startedAt: Date.now(), answered: true, answeredAt: call.answeredAt, status: 'answered' })
    await bridgeAndStartBot(call)
    log(chanId, `inbound answered as callType=${params.callType}`)
    call.armVoicemailFallback()
  } catch (err) {
    log(chanId, 'inbound wiring failed:', err?.message)
    void call.hangup('inbound wiring failed')
  }
}

/**
 * Local owner check, mirroring isOwnerNumber() in src/agent/lib/voice-call.ts (last 10
 * digits, so +880/0 prefixes don't matter). Only used on the app-unreachable fallback
 * path — the sip-inbound route stays authoritative whenever it answers.
 */
function isOwnerCaller(number) {
  const tail = (n) => String(n || '').replace(/\D/g, '').slice(-10)
  const target = tail(number)
  if (!target) return false
  return (process.env.OWNER_PHONE_NUMBERS || '')
    .split(',').map(tail).filter(Boolean)
    .some((n) => n === target)
}

/** BD numbers arrive as +8801… or 8801… or 01… — normalise to +E.164 for owner matching. */
function normalizeCaller(raw) {
  const d = String(raw || '').replace(/\D/g, '')
  if (!d) return ''
  if (d.startsWith('880')) return '+' + d
  if (d.startsWith('01') && d.length === 11) return '+88' + d
  return String(raw).startsWith('+') ? String(raw) : d
}

/** Ask our Next.js route for the persona + signed token + DB row. null on any failure. */
async function fetchInboundParams(caller, did) {
  if (!APP_URL || !(SIP_INBOUND_SECRET || INTERNAL_TOKEN)) return null
  try {
    const res = await fetch(`${APP_URL}/api/assistant/voice-call/sip-inbound${SIP_INBOUND_SECRET ? `?k=${encodeURIComponent(SIP_INBOUND_SECRET)}` : ''}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The shared token both machines already hold — nothing extra to provision.
        ...(INTERNAL_TOKEN ? { Authorization: `Bearer ${INTERNAL_TOKEN}` } : {}),
      },
      body: JSON.stringify({ caller, did }),
      signal: AbortSignal.timeout(8_000),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data?.ok || !data.params?.id) { log('sip-inbound route said', res.status, JSON.stringify(data).slice(0, 120)); return null }
    return data.params
  } catch (err) { log('sip-inbound fetch failed:', err?.message); return null }
}

async function onAriEvent(e) {
  const chanId = e.channel?.id
  switch (e.type) {
    case 'StasisStart': {
      const call = chanId && calls.get(chanId)
      if (!call) {
        // Unknown channel entering our Stasis app. Either the externalMedia leg we
        // just created (no args — ignore, it is already being bridged) or an INBOUND
        // PSTN call handed over by the from-alma dialplan: Stasis(alma-sip,inbound).
        if ((e.args || [])[0] === 'inbound') { await onInboundCall(e); return }
        // Anything else that is NOT our AudioSocket leg would sit in Stasis forever
        // (nothing drives it), holding a channel. Hang it up rather than leak.
        if (!/^AudioSocket\//.test(e.channel?.name || '')) {
          log(chanId, 'stray channel in Stasis — hanging up', e.channel?.name || '')
          await ari('DELETE', `/channels/${chanId}`).catch(() => {})
        }
        return
      }
      if (call.answered) return
      // Transfer path: a forward leg answering just needs to join the existing bridge.
      if (call._bridgeInto) {
        call.answered = true
        call.answeredAt = Date.now()
        try { await ari('POST', `/bridges/${call._bridgeInto}/addChannel`, { channel: call.channelId }) }
        catch (err) { log(call.channelId, 'forward bridge failed', err?.message) }
        return
      }
      // Our originated PSTN channel just answered and entered Stasis.
      call.answered = true
      call.answeredAt = Date.now()
      putCdr(call.channelId, { answered: true, answeredAt: call.answeredAt, status: 'answered' })
      try {
        // One-way message call (the NGS <Play> replacement): speak the file and hang up.
        // No bot, no Gemini spend — this is the alert/notification path.
        if (call.playOnly) { await playAndHangup(call); return }
        await bridgeAndStartBot(call)
        log(call.channelId, 'answered -> wired')
      } catch (err) {
        log(call.channelId, 'StasisStart wiring failed:', err?.message)
        void call.hangup('wiring failed')
      }
      break
    }
    case 'ChannelDestroyed': {
      // The only place Asterisk tells us WHY the leg ended — keep it for the sweep.
      const call = chanId && calls.get(chanId)
      // A forward leg dying tells us how the human-to-human half went; fold it into the
      // ORIGINAL call's record, which is the row the owner actually reads.
      const fwdParent = call?._transferParent
      if (fwdParent && cdr.has(fwdParent)) {
        const answered = Boolean(call.answered)
        putCdr(fwdParent, {
          transferAnswered: answered,
          transferTalkSecs: answered && call.answeredAt ? Math.round((Date.now() - call.answeredAt) / 1000) : 0,
          transferCauseTxt: e.cause_txt ?? '',
        })
      }
      if (chanId && cdr.has(chanId)) {
        putCdr(chanId, {
          endedAt: Date.now(),
          cause: e.cause ?? null,
          causeTxt: e.cause_txt ?? '',
          status: outcomeFromCause(Boolean(call?.answered ?? cdr.get(chanId)?.answered), e.cause),
        })
        void persistCdr(chanId)
      }
      if (call && !call.closed) void call.hangup(`ari ${e.type}`)
      break
    }
    case 'PlaybackFinished': {
      // target_uri is channel:<id> for one-way message calls and bridge:<id> for the
      // voicemail prompt, so resolve both shapes.
      const target = String(e.playback?.target_uri || '')
      const id = target.replace(/^(channel|bridge):/, '')
      const call = calls.get(id) || [...calls.values()].find((c) => c.bridgeId === id)
      if (!call || call.closed) break
      // The voicemail prompt just finished — now capture what the caller says.
      if (call.voicemail) { await call.recordVoicemail(); break }
      if (!call.playOnly) break
      // Confirmation calls stay on the line waiting for a keypress; plain message calls end.
      if (call.collectDigits) call.awaitDigit()
      else void call.hangup('playback finished')
      break
    }
    case 'RecordingFinished': {
      const name = String(e.recording?.name || '')
      const vmCall = [...calls.values()].find((c) => c.vmName === name)
      if (vmCall) { await vmCall.deliverVoicemail(); void vmCall.hangup('voicemail complete') }
      break
    }
    case 'ChannelDtmfReceived': {
      const call = chanId && calls.get(chanId)
      if (call && call.collectDigits && !call.digit) void call.onDigit(String(e.digit ?? ''))
      break
    }
    case 'StasisEnd':
    case 'ChannelHangupRequest': {
      const call = chanId && calls.get(chanId)
      if (call && !call.closed) void call.hangup(`ari ${e.type}`)
      break
    }
    default: break
  }
}

// ── control API (HTTP) — NGS-shaped ──────────────────────────────────────────
const eqConst = (a, b) => {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b))
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}
/**
 * Two accepted credentials, of equal strength:
 *  - the NGS-shaped key + secret pair (used by callers on this host), or
 *  - a Bearer AGENT_INTERNAL_TOKEN — the secret Vercel and this VPS ALREADY share.
 * Accepting the shared token means the cutover needs no new secret copied between machines,
 * and a secret that is never transported cannot leak in transit, in a chat log or in a
 * screenshot. Originating a call additionally requires the per-call HMAC either way.
 */
function authOk(req) {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (INTERNAL_TOKEN && bearer && eqConst(bearer, INTERNAL_TOKEN)) return true
  if (!KEY || !SECRET) return false
  return eqConst(req.headers['x-authorization'] || '', KEY)
    && eqConst(req.headers['x-authorization-secret'] || '', SECRET)
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = ''
    req.on('data', (c) => { d += c; if (d.length > 1_000_000) req.destroy() })
    req.on('end', () => resolve(d))
    req.on('error', () => resolve(''))
  })
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }

// Local-only format like ngsDialFormat: BD mobiles terminate on 01XXXXXXXXX.
function localDial(n) {
  const s = String(n || '').trim()
  if (s.startsWith('+880')) return '0' + s.slice(4)
  if (s.startsWith('880')) return '0' + s.slice(3)
  return s.replace(/^\+/, '')
}

const ctrlServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const m = url.pathname.match(/^\/api\/v1\/call(?:\/([^/]+))?$/)
  if (url.pathname === '/health') {
    return json(res, 200, { ok: true, service: 'alma-sip-gateway', ariReady: ARI_READY, active: calls.size, maxConcurrent: MAX_CONCURRENT, cdr: cdr.size, registration: { registered: regState.registered, status: regState.lastStatus, failures: regState.consecutiveFailures } })
  }
  if (!m) return json(res, 404, { error: 'not found' })
  if (!authOk(req)) {
    // Somebody is trying keys against a call-control API. Worth knowing about, but alert at
    // most once an hour so a scanner cannot turn this into its own notification flood.
    authFailures++
    if (authFailures >= 5 && Date.now() - lastAuthAlert > 3_600_000) {
      lastAuthAlert = Date.now(); authFailures = 0
      void alertOwner('ফোন সিস্টেমে অননুমোদিত চেষ্টা', 'কল-কন্ট্রোলে ভুল পাসওয়ার্ড দিয়ে বারবার ঢোকার চেষ্টা হচ্ছে।')
    }
    return json(res, 401, { error: 'unauthorized' })
  }
  if (!ARI_READY) return json(res, 503, { error: 'ARI not configured on this gateway' })
  const id = m[1]

  try {
    if (req.method === 'POST' && !id) {
      // Place a call. Body: JSON { to, from?, params:{...} }  (or form-encoded `to`)
      const bodyRaw = await readBody(req)
      let body = {}
      try { body = JSON.parse(bodyRaw || '{}') } catch {
        const p = new URLSearchParams(bodyRaw); body = { to: p.get('to'), from: p.get('from') }
      }
      const to = localDial(body.to)
      if (!to) return json(res, 400, { error: 'missing to' })
      const params = body.params || {}
      // One-way message call: no bot, just speak this audio and hang up (NGS <Play> parity).
      const playUrl = String(body.playUrl || '').trim()
      // Per-call HMAC is required for EVERY originate, one-way included. Previously one-way
      // calls were authorised by the control-API key alone, so a single leaked secret was
      // enough to dial arbitrary numbers on our trunk — the classic toll-fraud setup. Now an
      // attacker also needs AGENT_INTERNAL_TOKEN, which never travels in a request.
      const fail = authFailReason(params)
      if (fail) { log(`REFUSED originate: token ${fail}`); return json(res, 401, { error: `token: ${fail}` }) }
      // Destination allowlist. Toll fraud is only profitable against expensive international
      // destinations; this business only ever calls Bangladeshi numbers, so anything else is
      // refused outright rather than rate-limited.
      if (!DEST_ALLOW.test(to)) {
        log(`REFUSED originate -> ${to}: destination not allowed`)
        void alertOwner('ফোন লাইনে সন্দেহজনক কল আটকানো হয়েছে', `অনুমোদিত নয় এমন নম্বরে কল দেওয়ার চেষ্টা হয়েছিল: ${to}`)
        return json(res, 403, { error: 'destination not allowed' })
      }
      // Hourly ceiling on top of the concurrency cap: a stolen key cannot burn the balance
      // slowly either. Legitimate volume is a handful of calls an hour.
      const nowMs = Date.now()
      while (recentOriginates.length && nowMs - recentOriginates[0] > 3_600_000) recentOriginates.shift()
      if (recentOriginates.length >= MAX_PER_HOUR) {
        log(`REFUSED originate -> ${to}: hourly cap ${MAX_PER_HOUR} reached`)
        void alertOwner('ফোন কলের ঘণ্টা-সীমা শেষ', `গত এক ঘণ্টায় ${MAX_PER_HOUR}টি কল হয়েছে — নতুন কল আটকানো হচ্ছে। অপ্রত্যাশিত হলে দ্রুত দেখুন।`)
        return json(res, 429, { error: `hourly cap reached (${MAX_PER_HOUR})` })
      }
      recentOriginates.push(nowMs)
      if (calls.size >= MAX_CONCURRENT) {
        log(`REFUSED originate -> ${to}: ${calls.size}/${MAX_CONCURRENT} concurrent`)
        return json(res, 429, { error: `concurrency cap reached (${MAX_CONCURRENT})` })
      }
      const channelId = 'sip-' + randomUUID()
      const call = new Call(channelId, params)
      if (playUrl) {
        call.playOnly = true
        call.playUrl = playUrl
        // Confirmation mode: after the message, wait for the receiver to press a key
        // (1 = confirmed, 2 = declined by convention) and report what they pressed.
        call.collectDigits = Boolean(body.collectDigits)
        call.confirmCallbackUrl = String(body.confirmCallbackUrl || '')
        call.confirmRef = String(body.ref || '')
      }
      calls.set(channelId, call)
      putCdr(channelId, { direction: 'outbound', to, startedAt: Date.now(), answered: false, status: 'ringing' })
      try {
        await ari('POST', '/channels', {
          endpoint: `PJSIP/${to}@${TRUNK_ENDPOINT}`,
          app: ARI_APP,
          appArgs: 'outbound',
          channelId,
          timeout: RING_TIMEOUT,
          ...(CALLER_ID || body.from ? { callerId: String(body.from || CALLER_ID) } : {}),
        })
      } catch (err) {
        calls.delete(channelId); byUuid.delete(call.audioUuid)
        putCdr(channelId, { endedAt: Date.now(), status: 'failed', causeTxt: String(err?.message || '').slice(0, 120) })
        return json(res, 502, { error: `originate failed: ${err?.message}` })
      }
      log(channelId, `originate -> ${to}@${TRUNK_ENDPOINT}${call.playOnly ? ' [one-way]' : ''}`)
      return json(res, 200, { call_id: channelId, status: 'ringing' })
    }

    if (req.method === 'GET' && id) {
      // Live channel first (authoritative state), then the CDR — the outcome sweep asks
      // about calls that are already gone, and needs the hangup cause to report honestly.
      const active = calls.has(id)
      try {
        const ch = await ari('GET', `/channels/${id}`)
        return json(res, 200, { call_id: id, status: ch.state, answered: Boolean(calls.get(id)?.answered), ended: false, active })
      } catch { /* channel gone — fall through to the CDR */ }
      const rec = cdr.get(id)
      if (rec) return json(res, 200, { ...rec, ended: Boolean(rec.endedAt), active: false })
      return json(res, 404, { call_id: id, status: 'unknown', ended: true, active: false })
    }

    if (req.method === 'DELETE' && id) {
      const call = calls.get(id)
      if (call) await call.hangup('control DELETE')
      else await ari('DELETE', `/channels/${id}`).catch(() => {})
      return json(res, 200, { call_id: id, status: 'ended' })
    }

    if (req.method === 'PUT' && id) {
      // Live-modify / transfer. Body carries responseXml with <Dial to="…">. Phase 2
      // wires the full bridged transfer; Phase 1 answers safely so the bot never errors.
      const bodyRaw = await readBody(req)
      // The bot posts the XML the NGS way: form-encoded as `responseXml`, so the raw body is
      // percent-encoded and a regex over it finds nothing (live 2026-07-25: every transfer
      // failed with "no <Dial to=…>"). Decode first, and accept JSON/raw XML too.
      let xml = bodyRaw
      const ct = String(req.headers['content-type'] || '')
      if (ct.includes('application/x-www-form-urlencoded')) {
        xml = new URLSearchParams(bodyRaw).get('responseXml') || bodyRaw
      } else if (ct.includes('application/json')) {
        try { xml = JSON.parse(bodyRaw)?.responseXml || bodyRaw } catch { /* keep raw */ }
      }
      const to = (xml.match(/<Dial[^>]*\bto="([^"]+)"/i) || [])[1]
      const call = calls.get(id)
      if (!call) return json(res, 404, { error: 'no such call' })
      if (!to) return json(res, 400, { error: 'no <Dial to=…> in body' })
      const forwarded = await transferCall(call, localDial(to)).catch((e) => ({ ok: false, error: e?.message }))
      return json(res, forwarded.ok ? 200 : 502, forwarded)
    }

    return json(res, 405, { error: 'method not allowed' })
  } catch (err) {
    return json(res, 500, { error: err?.message || String(err) })
  }
})

// Phase 2 transfer: dial the forward number and bridge it in; drop the AI media leg
// so the two humans hear each other cleanly (mirrors the NGS <Dial> behaviour).
async function transferCall(call, forwardTo) {
  if (call.transferring) return { ok: true, status: 'already' }
  call.transferring = true
  const fwdId = 'sipfwd-' + randomUUID()
  await ari('POST', '/channels', {
    endpoint: `PJSIP/${forwardTo}@${TRUNK_ENDPOINT}`,
    app: ARI_APP,
    channelId: fwdId,
    // Shorter than a normal call: the caller is on hold listening to ringback, so a long
    // unanswered transfer is worse than falling back to the AI quickly.
    timeout: Number(process.env.SIP_TRANSFER_RING_TIMEOUT || 30),
    ...(CALLER_ID ? { callerId: CALLER_ID } : {}),
  })
  // register a minimal Call so its StasisStart bridges into the SAME bridge
  const fwd = new Call(fwdId, {})
  fwd._bridgeInto = call.bridgeId
  fwd._transferParent = call.channelId   // so the forward leg's outcome lands on the real call
  calls.set(fwdId, fwd)
  putCdr(call.channelId, { transferredTo: forwardTo, transferredAt: Date.now() })
  // when the forward answers, its StasisStart handler bridges it in; drop AI media.
  try { if (call.extChannelId) await ari('DELETE', `/channels/${call.extChannelId}`).catch(() => {}) } catch { /* */ }
  try { call.bot?.close() } catch { /* */ }
  call.botReady = false
  log(call.channelId, `transfer -> ${forwardTo} (fwd ${fwdId})`)
  return { ok: true, status: 'connecting' }
}

// ── per-call token (owner rule: only our backend opens the media path) ────────
function authFailReason(params) {
  if (!INTERNAL_TOKEN) return null // fail-open only when unconfigured (logged elsewhere)
  const id = params?.id, exp = Number(params?.exp), t = params?.t
  if (!id || !exp || !t) return 'missing id/exp/t'
  if (!Number.isFinite(exp) || Date.now() > exp) return 'token expired'
  const want = createHmac('sha256', INTERNAL_TOKEN).update(`relay:${id}:${exp}`).digest('hex')
  try {
    const a = Buffer.from(String(t)), b = Buffer.from(want)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return 'bad signature'
  } catch { return 'bad signature' }
  return null
}

// ── registration watchdog ────────────────────────────────────────────────────
/**
 * INBOUND depends entirely on our SIP registration holding. If it drops — trunk restart,
 * network blip, credential change — every incoming call to the business number dies and
 * NOTHING would tell us; the phone would just look quiet. NGS monitored their own side; now
 * that we own the stack we own the monitoring.
 *
 * Every REG_CHECK_SECS we ask Asterisk for the registration state, force a re-register on
 * failure, and alert the owner after REG_FAIL_ALERTS consecutive failures (once, not every
 * cycle) — plus a recovery message so a silent alarm can't be mistaken for "it fixed itself".
 */
const REG_NAME = process.env.SIP_REGISTRATION_NAME || 'alma-reg'
const REG_CHECK_SECS = Number(process.env.SIP_REG_CHECK_SECS || 60)
const REG_FAIL_ALERTS = Number(process.env.SIP_REG_FAIL_ALERTS || 2)
const execFileAsync = promisify(execFile)
const regState = { registered: null, consecutiveFailures: 0, alerted: false, lastCheck: 0, lastStatus: '' }

async function asteriskCli(command) {
  const { stdout } = await execFileAsync('asterisk', ['-rx', command], { timeout: 10_000 })
  return stdout || ''
}

/** Tell the owner something about the phone line. Best-effort, never throws. */
async function alertOwner(title, message) {
  if (!APP_URL || !INTERNAL_TOKEN) { log('alert skipped (APP_URL/token unset):', title, message); return }
  try {
    const res = await fetch(`${APP_URL}/api/assistant/internal/urgent-alert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INTERNAL_TOKEN}` },
      // voice:false — alerting about a broken phone line by phoning would be absurd.
      body: JSON.stringify({ tier: 2, title, message, voice: false, category: 'sip_registration' }),
      signal: AbortSignal.timeout(10_000),
    })
    // Log the outcome: an alert that silently fails to send makes the whole watchdog
    // worthless, and that failure must be visible in the logs rather than assumed away.
    const body = await res.text().catch(() => '')
    log(`alert "${title}" -> HTTP ${res.status} ${body.slice(0, 120)}`)
  } catch (err) { log('alert FAILED to send:', err?.message) }
}

async function checkRegistration() {
  let ok = false
  let statusWord = 'unknown'
  try {
    const out = await asteriskCli('pjsip show registrations')
    const line = out.split('\n').find((l) => l.includes(REG_NAME)) || ''
    statusWord = (line.match(/\b(Registered|Unregistered|Rejected|Auth\s*Sent|Sent)\b/i) || [])[1] || 'missing'
    ok = /Registered/i.test(statusWord)
  } catch (err) {
    statusWord = `check-failed: ${err?.message || err}`
  }
  regState.lastCheck = Date.now()
  regState.lastStatus = statusWord
  regState.registered = ok

  if (ok) {
    if (regState.alerted) {
      await alertOwner('ফোন লাইন আবার ঠিক আছে', 'SIP registration ফিরে এসেছে — ইনকামিং কল আবার আসছে।')
      log('registration RECOVERED')
    }
    regState.consecutiveFailures = 0
    regState.alerted = false
    return
  }

  regState.consecutiveFailures++
  log(`registration NOT OK (${statusWord}) — failure #${regState.consecutiveFailures}`)
  // Try to heal before shouting: a single missed refresh is normal.
  try { await asteriskCli(`pjsip send register ${REG_NAME}`) } catch { /* best effort */ }
  if (regState.consecutiveFailures >= REG_FAIL_ALERTS && !regState.alerted) {
    regState.alerted = true
    await alertOwner(
      'জরুরি: ফোন লাইনের registration পড়ে গেছে',
      `আমাদের SIP registration "${statusWord}" অবস্থায় আছে — এই মুহূর্তে ব্যবসার নম্বরে আসা কল আমাদের কাছে পৌঁছাচ্ছে না। আবার registration করার চেষ্টা চলছে।`,
    )
  }
}

// ── boot ─────────────────────────────────────────────────────────────────────
audioServer.listen(AS_PORT, AS_BIND, () => log(`AudioSocket TCP listening ${AS_BIND}:${AS_PORT} (advertise ${AS_ADVERTISE})`))
for (const addr of CTRL_BIND) {
  // One server per address. A missing Docker bridge must not stop the loopback listener,
  // so a failed bind is logged and skipped rather than crashing the gateway.
  const srv = addr === CTRL_BIND[0] ? ctrlServer : http.createServer(ctrlServer.listeners('request')[0])
  srv.on('error', (err) => log(`control API bind ${addr}:${CTRL_PORT} failed: ${err.message}`))
  srv.listen(CTRL_PORT, addr, () => log(`control API listening ${addr}:${CTRL_PORT}`))
}
startAri()
if (ARI_READY) {
  void checkRegistration()
  setInterval(() => { void checkRegistration() }, REG_CHECK_SECS * 1000).unref()
}
log(`boot: ariReady=${ARI_READY} trunk=${TRUNK_ENDPOINT} bot=${BOT_WS_URL} ctrlBase=${CTRL_BASE}`)
