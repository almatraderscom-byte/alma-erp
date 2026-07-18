/**
 * Twilio ConversationRelay bridge — two-way realtime Bangla calls in the SAME
 * Google voice the owner already loves (bn-IN-Chirp3-HD-Charon), replacing the
 * ElevenLabs ConvAI agent whose realtime Bangla accent is poor.
 *
 * Twilio does the whole media loop (streaming STT + streaming Google TTS +
 * barge-in); this server only speaks ConversationRelay's TEXT protocol over a
 * WebSocket: Twilio sends the caller's transcribed utterance, we stream back
 * Gemini tokens, Twilio speaks them in Charon's voice. No audio handling here.
 *
 * Protocol (Twilio → us): setup / prompt / interrupt / dtmf / error.
 * (us → Twilio): {type:'text', token, last} tokens, {type:'end'} to hang up.
 *
 * The Vercel app places the call with inline TwiML
 * (<Connect><ConversationRelay url="wss://…/relay?id&exp&t">) — see
 * src/agent/lib/voice-call.ts. The `t` token is HMAC-signed with
 * AGENT_INTERNAL_TOKEN so only our own calls can connect. When the call ends we
 * POST the transcript + a Gemini summary to /api/assistant/voice-call/relay-report,
 * which updates the agent_voice_calls row and notifies the owner.
 *
 * NOTE: Twilio requires TLS (wss://) for ConversationRelay — the VPS must expose
 * this port behind HTTPS (Caddy/nginx/cloudflared), unlike the plain-HTTP TwiML
 * server on :3099. Set VOICE_RELAY_PUBLIC_WSS_URL to the public wss URL.
 */

import http from 'http'
import { createHmac, timingSafeEqual } from 'crypto'
import { WebSocketServer } from 'ws'
import { GoogleGenAI } from '@google/genai'
import { logCost } from '../cost-log.mjs'
import { isUnintelligibleTranscript, endSignalFromCaller, isHangupConfirmation } from './transcript-guard.mjs'
import { handleSarvamMediaUpgrade } from './sarvam-media.mjs'

const RELAY_MODEL = () => process.env.VOICE_RELAY_MODEL_ID || 'gemini-3.5-flash'
const MAX_CALL_MINUTES = () => Number(process.env.VOICE_CALL_MAX_MINUTES) || 10
/** Hang up if the caller never speaks (voicemail / carrier intercept / dead air). */
const IDLE_HANGUP_SEC = () => Number(process.env.VOICE_RELAY_IDLE_HANGUP_SEC) || 30
/** Spoken end-of-conversation marker the model emits when the job is done. */
const END_MARKER = '[[END_CALL]]'

function signingSecret() {
  return process.env.AGENT_INTERNAL_TOKEN ?? ''
}

export function signRelayToken(callRecordId, expMs) {
  return createHmac('sha256', signingSecret()).update(`relay:${callRecordId}:${expMs}`).digest('hex')
}

function verifyRelayToken(callRecordId, expMs, token) {
  if (!token || !callRecordId || !Number.isFinite(expMs)) return false
  if (Date.now() > expMs) return false
  const expected = signRelayToken(callRecordId, expMs)
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(token, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function buildSystemPrompt({ purpose, recipientName }) {
  // Is the person on the line the owner himself? (agent sometimes calls Boss directly)
  const callingOwner = /\b(boss|বস|maruf|মারুফ|মালিক)\b/i.test(String(recipientName ?? ''))
  return (
    `তুমি মালিকের ব্যক্তিগত সহকারী — ${recipientName ? recipientName + ' কে' : 'একজনকে'} ` +
    `মালিকের পক্ষ থেকে ফোন করেছ। উদ্দেশ্য: ${purpose || 'মালিকের বার্তা পৌঁছে দেওয়া'}।\n` +
    `নিয়ম:\n` +
    (callingOwner
      ? `- অন্য পক্ষ স্বয়ং মালিক। তাঁকে সবসময় **"বস"** বলে সম্বোধন করবে — কখনো "স্যার", "জনাব" বা "স্যার/ম্যাডাম" নয় (এটা কঠোর নিয়ম)।\n`
      : '') +
    `- শুধুই সহজ, বিনয়ী, কথ্য বাংলায় কথা বলো। এটা ফোন কল — প্রতিটা উত্তর ১-৩টা ছোট বাক্যে, কোনো markdown/emoji/তালিকা নয়।\n` +
    `- অন্য পক্ষের কথা মন দিয়ে শোনো, প্রয়োজনীয় তথ্য আদায় করো।\n` +
    `- **না বুঝলে বানিয়ে বলবে না** — লাইন কেটে গেলে বা কথা অস্পষ্ট হলে সোজা জিজ্ঞেস করো ` +
    `"দুঃখিত, একটু কেটে গেল — আরেকবার বলবেন?"। অনুমান করে নিজের মতো কথা চালিয়ে যাওয়া কঠোরভাবে নিষিদ্ধ।\n` +
    `- **তুমি নিজে থেকে কখনো কল কাটবে না বা বিদায় নেবে না।** অন্য পক্ষ যতক্ষণ কথা বলছে বা প্রশ্ন করছে, ` +
    `স্বাভাবিকভাবে কথা চালিয়ে যাও। উদ্দেশ্য শেষ মনে হলেও নিজে থেকে "আর কিছু লাগবে?"-এর মতো প্রশ্ন বারবার ` +
    `করবে না — কেবল যা জিজ্ঞেস করা হয়েছে তার সহজ উত্তর দাও, তারপর চুপ করে শোনো।\n` +
    `- কল কখন রাখতে হবে সেটা সিস্টেম নিজেই সামলায় — অন্য পক্ষ রাখতে চাইলে সিস্টেম নিশ্চিত করে কল কেটে দেবে। ` +
    `তাই তুমি ${END_MARKER} বা বিদায়-বার্তা নিজে থেকে লিখবে না; শুধু কথা চালিয়ে যাও।\n` +
    `- অপ্রাসঙ্গিক/হারাম বিষয়ে যেও না; না জানলে বলো মালিককে জিজ্ঞেস করে জানানো হবে।`
  )
}


// Diagnostics visible on /health — per-turn latency/errors and report outcomes,
// so failures are readable remotely instead of guessed at.
export const relayDiag = {
  lastTurns: [],
  lastReports: [],
  note(list, entry) {
    list.push({ ts: new Date().toISOString(), ...entry })
    if (list.length > 12) list.shift()
  },
}

/** One live call session — history, streaming state, reporting. */
class RelaySession {
  constructor(ws, callRecordId, genai) {
    this.ws = ws
    this.callRecordId = callRecordId
    this.genai = genai
    this.history = [] // {role:'user'|'assistant', text}
    this.params = {}
    this.callSid = null
    this.startedAt = Date.now()
    this.abort = null
    this.ended = false
    this.reported = false
    this.userTurns = 0
    /** Consecutive mis-heard utterances — 3 in a row means the line/ASR is unusable. */
    this.misheardStreak = 0
    /** True after the caller asked to end and we asked them to confirm. */
    this.awaitingHangupConfirm = false
    this.maxTimer = setTimeout(() => this.timeUp(), MAX_CALL_MINUTES() * 60_000)
    // Idle-hangup: if no human speech is ever transcribed, the call reached
    // voicemail / a carrier intercept / dead air — don't monologue for the full
    // 10-min cap (live proof: a 609s call the owner's phone never even rang).
    this.idleTimer = setTimeout(() => this.idleGiveUp(), IDLE_HANGUP_SEC() * 1000)
  }

  idleGiveUp() {
    if (this.userTurns > 0 || this.ended) return
    this.ended = true
    console.warn(`[voice-relay] idle give-up (no speech in ${IDLE_HANGUP_SEC()}s) — call ${this.callRecordId}`)
    relayDiag.note(relayDiag.lastReports, { call: this.callRecordId, idleHangup: true })
    this.send({ type: 'end' })
  }

  /** Caller confirmed they want to end — say goodbye and hang up (deterministic). */
  confirmedHangup() {
    if (this.ended) return
    this.ended = true
    console.log(`[voice-relay] hang-up confirmed by caller — call ${this.callRecordId}`)
    this.history.push({ role: 'assistant', text: 'আচ্ছা বস, রাখছি তাহলে। আল্লাহ হাফেজ।' })
    this.speak('আচ্ছা বস, রাখছি তাহলে। আল্লাহ হাফেজ।', true)
    // Let Twilio flush the goodbye TTS before the socket closes.
    setTimeout(() => this.send({ type: 'end' }), 3500)
  }

  send(obj) {
    if (this.ws.readyState === this.ws.OPEN) {
      try { this.ws.send(JSON.stringify(obj)) } catch { /* socket died mid-send */ }
    }
  }

  onMessage(raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    switch (msg.type) {
      case 'setup':
        this.callSid = msg.callSid ?? null
        this.params = msg.customParameters ?? {}
        break
      case 'dtmf': {
        // STT-proof hang-up. Bangla telephony ASR mangles even "কেটে দাও" (heard
        // "খেতে দাও", live 2026-07-18), so the owner can ALWAYS end the call by
        // pressing any key — no recognition involved. A keypress is deliberate, so
        // it hangs up straight away (no confirm step).
        const digit = msg.digit ?? msg.digits?.digit ?? msg.dtmf?.digit ?? ''
        if (digit) {
          console.log(`[voice-relay] DTMF "${digit}" — hanging up — call ${this.callRecordId}`)
          this.confirmedHangup()
        }
        break
      }
      case 'prompt':
        // ConversationRelay delivers complete utterances (last !== false).
        if (msg.voicePrompt && msg.last !== false) {
          this.userTurns++
          clearTimeout(this.idleTimer) // real human speech — cancel idle-hangup
          // Mis-heard speech (Hindi-script / noise) never reaches the model: it would
          // answer the garbage confidently and drift off on its own. Ask to repeat,
          // and keep the bad text OUT of history so it can't poison later turns.
          if (isUnintelligibleTranscript(msg.voicePrompt)) {
            this.misheardStreak++
            relayDiag.note(relayDiag.lastTurns, {
              call: this.callRecordId,
              misheard: String(msg.voicePrompt).slice(0, 60),
              streak: this.misheardStreak,
            })
            this.askToRepeat()
            break
          }
          this.misheardStreak = 0

          // ── Deterministic hang-up (owner: "kete dao / ekhon rakho") ──────────
          // Ending the call is NOT left to the model — it kept asking "আর কিছু
          // বলবেন?" forever. The relay owns it: an end-signal → ask to confirm ONCE
          // → a yes hangs up. Anything else just continues the conversation.
          if (this.awaitingHangupConfirm) {
            this.awaitingHangupConfirm = false
            if (isHangupConfirmation(msg.voicePrompt)) { this.confirmedHangup(); break }
            // not a yes → caller had more to say; fall through and answer it.
          } else if (endSignalFromCaller(msg.voicePrompt)) {
            this.awaitingHangupConfirm = true
            this.history.push({ role: 'user', text: String(msg.voicePrompt) })
            this.history.push({ role: 'assistant', text: 'তাহলে কি এখন কল রাখব বস?' })
            this.speak('তাহলে কি এখন কল রাখব বস?', true)
            break
          }

          this.history.push({ role: 'user', text: String(msg.voicePrompt) })
          void this.respond()
        }
        break
      case 'interrupt': {
        // Caller barged in — stop generating; keep only what was actually spoken.
        this.abort?.abort()
        const spoken = msg.utteranceUntilInterrupt
        const lastTurn = this.history[this.history.length - 1]
        if (spoken && lastTurn?.role === 'assistant') lastTurn.text = String(spoken)
        break
      }
      case 'error':
        console.warn('[voice-relay] twilio error:', msg.description ?? JSON.stringify(msg))
        break
      default:
        break
    }
  }

  /**
   * Deterministic "say that again" — spoken WITHOUT the model, so a mis-heard line
   * can never turn into an invented answer. After 3 straight misses the line itself
   * is the problem; say so honestly and hang up rather than loop forever.
   */
  askToRepeat() {
    if (this.ended) return
    if (this.misheardStreak >= 3) {
      this.ended = true
      this.speak('লাইনটা খুব খারাপ, আপনার কথা ধরতে পারছি না। পরে আবার কল দিচ্ছি। আসসালামু আলাইকুম।', true)
      setTimeout(() => this.send({ type: 'end' }), 5000)
      return
    }
    const line = this.misheardStreak === 1
      ? 'দুঃখিত, একটু কেটে গেল — আরেকবার বলবেন?'
      : 'এখনও পরিষ্কার শুনতে পাচ্ছি না। একটু আস্তে করে আবার বলুন প্লিজ।'
    this.speak(line, true)
  }

  /** Speak one ready-made line (no model involved). */
  speak(text, last = false) {
    this.send({ type: 'text', token: text, last: false })
    if (last) this.send({ type: 'text', token: '', last: true })
  }

  async respond() {
    this.abort?.abort()
    const ac = new AbortController()
    this.abort = ac

    // Phone latency: cap history (old turns add tokens = slower first byte).
    const contents = this.history.slice(-16).map((t) => ({
      role: t.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: t.text }],
    }))

    // Watchdog: a hung LLM call used to mean dead silence on the line. Abort
    // hard at 12s — the catch block speaks a fallback so the caller always
    // hears SOMETHING.
    const watchdog = setTimeout(() => ac.abort(new Error('llm_timeout')), 12_000)
    const startedAt = Date.now()

    let full = ''
    let sawEnd = false
    try {
      const stream = await this.genai.models.generateContentStream({
        model: RELAY_MODEL(),
        contents,
        config: {
          systemInstruction: buildSystemPrompt({
            purpose: this.params.purpose,
            recipientName: this.params.recipientName,
          }),
          abortSignal: ac.signal,
          temperature: 0.6,
          // Spoken replies must be short and START fast: no hidden reasoning
          // pass (flash "thinks" by default — that was the 10s dead air), and
          // a hard cap keeps answers conversation-sized.
          maxOutputTokens: 300,
          thinkingConfig: { thinkingBudget: 0 },
        },
      })
      // Prosody: Twilio synthesises each text message we send as its own TTS unit, so
      // forwarding raw Gemini chunks made the voice speak in fragments — the owner's
      // "robotic sound". Twilio's own best-practices note that holding text back gives
      // "a smoother and more consistent pace of speaking". We flush on sentence
      // boundaries instead: whole clauses reach TTS (natural intonation) while the
      // FIRST sentence still leaves as soon as it is complete, so latency barely moves.
      let buf = ''
      const flush = () => {
        const out = buf.trim()
        buf = ''
        if (out) this.send({ type: 'text', token: out + ' ', last: false })
      }
      for await (const chunk of stream) {
        if (ac.signal.aborted) return
        let token = chunk.text ?? ''
        if (!token) continue
        full += token
        if (full.includes(END_MARKER)) {
          sawEnd = true
          token = token.replace(END_MARKER, '')
          // Trim any half-emitted marker tail so it is never spoken aloud.
          for (let i = END_MARKER.length - 1; i > 0; i--) {
            if (token.endsWith(END_MARKER.slice(0, i))) { token = token.slice(0, -i); break }
          }
        }
        buf += token
        // Bangla danda, ?, !, or a long clause — flush a speakable unit.
        if (/[।?!]\s*$/.test(buf) || buf.length > 160) flush()
        if (sawEnd) break
      }
      flush()
    } catch (err) {
      // Barge-in / newer prompt aborted us — the newer respond() owns the floor.
      if (ac.signal.aborted && String(ac.signal.reason?.message) !== 'llm_timeout') {
        relayDiag.note(relayDiag.lastTurns, { call: this.callRecordId, ms: Date.now() - startedAt, aborted: true })
        return
      }
      console.warn('[voice-relay] LLM stream failed:', err?.message ?? err)
      relayDiag.note(relayDiag.lastTurns, {
        call: this.callRecordId,
        ms: Date.now() - startedAt,
        error: String(err?.message ?? err).slice(0, 160),
      })
      this.send({
        type: 'text',
        token: full
          ? ' — দুঃখিত বস, লাইনে একটু সমস্যা হলো। আবার বলুন?'
          : 'দুঃখিত বস, বুঝতে একটু সমস্যা হলো — আরেকবার বলবেন?',
        last: false,
      })
    } finally {
      clearTimeout(watchdog)
    }
    if (full) {
      relayDiag.note(relayDiag.lastTurns, { call: this.callRecordId, ms: Date.now() - startedAt, chars: full.length })
    }
    console.log(`[voice-relay] turn ${Date.now() - startedAt}ms — call ${this.callRecordId}`)

    this.send({ type: 'text', token: '', last: true })
    const spokenText = full.replace(END_MARKER, '').trim()
    if (spokenText) this.history.push({ role: 'assistant', text: spokenText })

    if (sawEnd && !this.ended) {
      // Guard against a self-terminating model: only hang up if the OTHER PARTY
      // actually signalled they were done. The owner's complaint "auto kete gese,
      // ami kati ni" was the model emitting END_CALL because it decided the purpose
      // was fulfilled. If the last human turn shows no goodbye, ignore the marker,
      // ask if there's anything else, and keep the line open.
      const lastUser = [...this.history].reverse().find((t) => t.role === 'user')?.text ?? ''
      if (endSignalFromCaller(lastUser)) {
        this.ended = true
        console.log(`[voice-relay] END honored (caller said bye) — call ${this.callRecordId}`)
        // Give Twilio a beat to flush TTS of the goodbye before hanging up.
        setTimeout(() => this.send({ type: 'end' }), 4000)
      } else {
        console.warn(`[voice-relay] END suppressed (caller not done: "${lastUser.slice(0, 40)}") — call ${this.callRecordId}`)
        this.send({ type: 'text', token: 'আর কিছু বলবেন বস?', last: true })
      }
    }
  }

  timeUp() {
    if (this.ended) return
    this.ended = true
    this.send({
      type: 'text',
      token: 'আমাদের কথার সময় শেষ হয়ে যাচ্ছে, তাই এখন রাখছি। আসসালামু আলাইকুম।',
      last: true,
    })
    setTimeout(() => this.send({ type: 'end' }), 5000)
  }

  async close() {
    clearTimeout(this.maxTimer)
    clearTimeout(this.idleTimer)
    this.abort?.abort()
    if (this.reported) return
    this.reported = true
    try {
      await this.report()
      relayDiag.note(relayDiag.lastReports, { call: this.callRecordId, ok: true, turns: this.history.length })
    } catch (err) {
      console.warn('[voice-relay] report failed:', err?.message ?? err)
      relayDiag.note(relayDiag.lastReports, {
        call: this.callRecordId,
        ok: false,
        turns: this.history.length,
        error: String(err?.message ?? err).slice(0, 160),
      })
    }
  }

  /** Post transcript + Gemini summary back to the app → owner notification. */
  async report() {
    const appUrl = (process.env.APP_URL ?? '').replace(/\/$/, '')
    const token = process.env.AGENT_INTERNAL_TOKEN
    if (!appUrl || !token || !this.callRecordId) return

    const durationSecs = Math.round((Date.now() - this.startedAt) / 1000)
    const transcript = this.history.map((t) => ({
      role: t.role === 'assistant' ? 'agent' : 'user',
      message: t.text,
    }))

    // Summary is best-effort and must NEVER block/kill the report: hard 8s cap,
    // no thinking pass (an uncapped call here hung once and a worker restart
    // killed the pending report — owner got no post-call summary at all).
    let summary = null
    if (this.history.length) {
      try {
        const convoText = this.history
          .map((t) => `${t.role === 'assistant' ? 'এজেন্ট' : 'ব্যক্তি'}: ${t.text}`)
          .join('\n')
        const res = await this.genai.models.generateContent({
          model: RELAY_MODEL(),
          contents: `এই ফোন কথোপকথনের ২-৩ বাক্যের বাংলা সারাংশ লেখো (মূল তথ্য/সিদ্ধান্তসহ):\n\n${convoText}`,
          config: { abortSignal: AbortSignal.timeout(8_000), thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 200 },
        })
        summary = res.text?.trim() || null
      } catch { /* summary is best-effort */ }
    }

    void logCost({
      provider: 'twilio',
      kind: 'call',
      units: { callSid: this.callSid ?? this.callRecordId, relay: true, seconds: durationSecs },
      costUsd: (durationSecs / 60) * 0.09, // ConversationRelay $0.07/min + carrier ≈ safe estimate
      jobId: this.callSid ?? this.callRecordId,
      dedupKey: `relay:${this.callRecordId}`,
    })

    const body = JSON.stringify({
      callRecordId: this.callRecordId,
      callSid: this.callSid,
      transcript,
      summary,
      durationSecs,
      status: this.history.length ? 'completed' : 'no_answer',
    })
    // One retry — the owner's post-call summary must survive a transient blip.
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

export function startVoiceRelayServer() {
  const port = Number(process.env.VOICE_RELAY_PORT ?? 3100)
  if (!process.env.GEMINI_API_KEY) {
    console.warn('[voice-relay] GEMINI_API_KEY missing — relay server not started')
    return null
  }
  if (!signingSecret()) {
    console.warn('[voice-relay] AGENT_INTERNAL_TOKEN missing — relay server not started')
    return null
  }

  const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

  // Rolling log of the last upgrade attempts — surfaced on /health so a remote
  // session can SEE whether Twilio's connection ever arrived and why it was
  // accepted/rejected, without VPS shell access.
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
        service: 'voice-relay',
        recentUpgrades,
        lastTurns: relayDiag.lastTurns,
        lastReports: relayDiag.lastReports,
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
    // /relay = ConversationRelay (Google/Deepgram); /media = Sarvam Media Streams.
    const isRelay = url.pathname === '/relay'
    const isMedia = url.pathname === '/media'
    // Twilio Media Streams does NOT forward the URL query string to <Stream>, so the
    // token can't ride the URL there — /media carries it in <Parameter> and verifies
    // on the 'start' frame instead (see sarvam-media.mjs). /relay keeps URL-token auth.
    const bad = (!isRelay && !isMedia) ? `bad path ${url.pathname}` : (isRelay && !verifyRelayToken(id, exp, t)) ? 'token verify failed' : null
    if (bad) {
      noteUpgrade({ ok: false, reason: bad, id: id ?? null, from })
      console.warn(`[voice-relay] upgrade rejected (${bad}) from ${from}`)
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    noteUpgrade({ ok: true, id, from, path: url.pathname })
    if (isMedia) {
      handleSarvamMediaUpgrade({ req, socket, head, wss, verifyRelayToken })
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = new RelaySession(ws, id, genai)
      console.log(`[voice-relay] session open — call ${id}`)
      ws.on('message', (raw) => session.onMessage(raw.toString()))
      ws.on('close', () => {
        console.log(`[voice-relay] session closed — call ${id}`)
        void session.close()
      })
      ws.on('error', (err) => console.warn('[voice-relay] ws error:', err.message))
    })
  })

  server.listen(port, '0.0.0.0', () => {
    console.log(`[voice-relay] listening on :${port} (model ${RELAY_MODEL()})`)
  })

  return server
}
