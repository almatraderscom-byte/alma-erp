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
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { WebSocket } from 'ws'
import { muLawToPcm16, pcm16ToMuLaw } from './sarvam-media.mjs'

// ── config (VPS .env only — secrets never in git) ────────────────────────────
const CTRL_PORT = Number(process.env.SIP_GATEWAY_PORT || 8770)
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
// Where one-way message audio is staged for Asterisk to play (must be readable by Asterisk).
const PLAY_DIR = process.env.SIP_PLAY_DIR || tmpdir()
/**
 * How long to let the callee's phone ring, in seconds. ARI's default is 30, which is too
 * short in practice — live 2026-07-25: the owner reached his phone at ~30s, by which time we
 * had already cancelled, so the CARRIER answered him with "the number you're calling is busy"
 * and cut. Both failed calls ended at exactly 30.000s with hangup cause 0 (our own cancel),
 * which is what identified it. 45s matches the Twilio path's Timeout.
 */
const RING_TIMEOUT = Number(process.env.SIP_RING_TIMEOUT || 45)

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
    ws.on('close', () => { this.botReady = false; if (!this.closed && !this.transferring) this.hangup('bot ws closed') })
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
      // Native barge-in flush: drop everything queued for Asterisk so the model's new
      // turn starts clean (mirrors the bot's own out-buffer flush).
      this.playQueue.length = 0
      this.slinResidual = Buffer.alloc(0)
    }
  }

  // ── AudioSocket (Asterisk externalMedia) ───────────────────────────────────
  attachAudioSocket(socket) {
    this.asSocket = socket
    this.startPlayout()
  }

  // 20ms-paced playout: the bot drains its own buffer in catch-up BURSTS (up to ~1.2s of
  // frames in one tick). Writing those straight to AudioSocket = discontinuity = crackle.
  // Queue them and emit exactly one 320-byte slin frame every 20ms so Asterisk gets a
  // steady stream. Bounded so a runaway never grows without limit.
  startPlayout() {
    if (this.playTimer) return
    this.playTimer = setInterval(() => {
      if (this.closed) return
      const frame = this.playQueue.shift()
      if (frame) this.rawWriteAudio(frame)
    }, 20)
  }

  // Asterisk -> gateway: slin8k audio -> μ-law -> bot media frame.
  onAsteriskAudio(slin) {
    if (!this.botReady) return
    const mu = pcm16ToMuLaw(slin)
    this.send({ event: 'media', streamId: this.channelId, media: { payload: mu.toString('base64') } })
  }

  // Cut the bot's slin into steady 20ms (320-byte) frames and enqueue for paced playout.
  enqueueAudio(slin) {
    const buf = Buffer.concat([this.slinResidual, slin])
    const FRAME = 320 // 20ms slin @ 8k
    let off = 0
    for (; off + FRAME <= buf.length; off += FRAME) this.playQueue.push(buf.subarray(off, off + FRAME))
    this.slinResidual = buf.subarray(off)
    // Safety: never let a runaway buffer grow unbounded (~10s cap); drop oldest.
    if (this.playQueue.length > 500) this.playQueue.splice(0, this.playQueue.length - 500)
  }
  rawWriteAudio(payload) {
    if (!this.asSocket || this.asSocket.destroyed) return
    const hdr = Buffer.allocUnsafe(3)
    hdr[0] = AS_TYPE_AUDIO
    hdr.writeUInt16BE(payload.length, 1)
    try { this.asSocket.write(Buffer.concat([hdr, payload])) } catch { /* */ }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  async hangup(reason) {
    if (this.closed) return
    this.closed = true
    log(this.channelId, 'hangup', reason ? `(${reason})` : '')
    if (this.playTimer) { clearInterval(this.playTimer); this.playTimer = null }
    try { this.bot?.close() } catch { /* */ }
    try { this.asSocket?.end() } catch { /* */ }
    // End the PSTN leg + tidy the bridge/externalMedia via ARI.
    try { if (this.extChannelId) await ari('DELETE', `/channels/${this.extChannelId}`).catch(() => {}) } catch { /* */ }
    try { await ari('DELETE', `/channels/${this.channelId}`).catch(() => {}) } catch { /* */ }
    try { if (this.bridgeId) await ari('DELETE', `/bridges/${this.bridgeId}`).catch(() => {}) } catch { /* */ }
    if (this.playFile) await unlink(this.playFile).catch(() => {})
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
        if (call) void call.hangup('audiosocket terminate')
        socket.end()
      } else if (type === AS_TYPE_ERROR) {
        log(call?.channelId || '?', 'AudioSocket error frame')
      }
    }
  })
  socket.on('close', () => { if (call && !call.closed) void call.hangup('audiosocket closed') })
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
    }
    log(chanId, `inbound params fallback (app unreachable) owner=${owner ? 'y' : 'n'}`)
  }
  const call = new Call(chanId, { ...params, caller, did })
  call.inbound = true
  calls.set(chanId, call)
  try {
    await ari('POST', `/channels/${chanId}/answer`)
    call.answered = true
    await bridgeAndStartBot(call)
    log(chanId, `inbound answered as callType=${params.callType}`)
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
  if (!APP_URL || !SIP_INBOUND_SECRET) return null
  try {
    const res = await fetch(`${APP_URL}/api/assistant/voice-call/sip-inbound?k=${encodeURIComponent(SIP_INBOUND_SECRET)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
        try { await ari('POST', `/bridges/${call._bridgeInto}/addChannel`, { channel: call.channelId }) }
        catch (err) { log(call.channelId, 'forward bridge failed', err?.message) }
        return
      }
      // Our originated PSTN channel just answered and entered Stasis.
      call.answered = true
      putCdr(call.channelId, { answered: true, answeredAt: Date.now(), status: 'answered' })
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
      if (chanId && cdr.has(chanId)) {
        putCdr(chanId, {
          endedAt: Date.now(),
          cause: e.cause ?? null,
          causeTxt: e.cause_txt ?? '',
          status: outcomeFromCause(Boolean(call?.answered ?? cdr.get(chanId)?.answered), e.cause),
        })
      }
      if (call && !call.closed) void call.hangup(`ari ${e.type}`)
      break
    }
    case 'PlaybackFinished': {
      // One-way message call: the audio finished, so end the leg (nothing else to say).
      const target = String(e.playback?.target_uri || '').replace(/^channel:/, '')
      const call = target && calls.get(target)
      if (call && call.playOnly && !call.closed) void call.hangup('playback finished')
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
function authOk(req) {
  if (!KEY || !SECRET) return false
  const k = req.headers['x-authorization'] || ''
  const s = req.headers['x-authorization-secret'] || ''
  const eq = (a, b) => {
    const ba = Buffer.from(String(a)), bb = Buffer.from(String(b))
    return ba.length === bb.length && timingSafeEqual(ba, bb)
  }
  return eq(k, KEY) && eq(s, SECRET)
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
    return json(res, 200, { ok: true, service: 'alma-sip-gateway', ariReady: ARI_READY, active: calls.size, maxConcurrent: MAX_CONCURRENT, cdr: cdr.size })
  }
  if (!m) return json(res, 404, { error: 'not found' })
  if (!authOk(req)) return json(res, 401, { error: 'unauthorized' })
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
      // Optional: verify the per-call token so only OUR backend can originate. One-way
      // calls carry no bot session, so they are authorised by the control-API key alone.
      if (!playUrl) {
        const fail = authFailReason(params)
        if (fail) return json(res, 401, { error: `token: ${fail}` })
      }
      if (calls.size >= MAX_CONCURRENT) {
        log(`REFUSED originate -> ${to}: ${calls.size}/${MAX_CONCURRENT} concurrent`)
        return json(res, 429, { error: `concurrency cap reached (${MAX_CONCURRENT})` })
      }
      const channelId = 'sip-' + randomUUID()
      const call = new Call(channelId, params)
      if (playUrl) { call.playOnly = true; call.playUrl = playUrl }
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
      const to = (bodyRaw.match(/<Dial[^>]*\bto="([^"]+)"/i) || [])[1]
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
  calls.set(fwdId, fwd)
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

// ── boot ─────────────────────────────────────────────────────────────────────
audioServer.listen(AS_PORT, AS_BIND, () => log(`AudioSocket TCP listening ${AS_BIND}:${AS_PORT} (advertise ${AS_ADVERTISE})`))
ctrlServer.listen(CTRL_PORT, '0.0.0.0', () => log(`control API listening :${CTRL_PORT}`))
startAri()
log(`boot: ariReady=${ARI_READY} trunk=${TRUNK_ENDPOINT} bot=${BOT_WS_URL} ctrlBase=${CTRL_BASE}`)
