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

const RELAY_MODEL = () => process.env.VOICE_RELAY_MODEL_ID || 'gemini-3.5-flash'
const MAX_CALL_MINUTES = () => Number(process.env.VOICE_CALL_MAX_MINUTES) || 10
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
  return (
    `তুমি মালিকের ব্যক্তিগত সহকারী — ${recipientName ? recipientName + ' কে' : 'একজনকে'} ` +
    `মালিকের পক্ষ থেকে ফোন করেছ। উদ্দেশ্য: ${purpose || 'মালিকের বার্তা পৌঁছে দেওয়া'}।\n` +
    `নিয়ম:\n` +
    `- শুধুই সহজ, বিনয়ী, কথ্য বাংলায় কথা বলো। এটা ফোন কল — ছোট ছোট বাক্য, কোনো markdown/emoji/তালিকা নয়।\n` +
    `- অন্য পক্ষের কথা মন দিয়ে শোনো, প্রয়োজনীয় তথ্য আদায় করো।\n` +
    `- উদ্দেশ্য পূরণ হয়ে গেলে ভদ্রভাবে বিদায় নাও এবং বিদায়-বাক্যের একদম শেষে ${END_MARKER} লেখো (ওটা উচ্চারিত হবে না)।\n` +
    `- অপ্রাসঙ্গিক/হারাম বিষয়ে যেও না; না জানলে বলো মালিককে জিজ্ঞেস করে জানানো হবে।`
  )
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
    this.maxTimer = setTimeout(() => this.timeUp(), MAX_CALL_MINUTES() * 60_000)
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
      case 'prompt':
        // ConversationRelay delivers complete utterances (last !== false).
        if (msg.voicePrompt && msg.last !== false) {
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

  async respond() {
    this.abort?.abort()
    const ac = new AbortController()
    this.abort = ac

    const contents = this.history.map((t) => ({
      role: t.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: t.text }],
    }))

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
        },
      })
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
        if (token) this.send({ type: 'text', token, last: false })
        if (sawEnd) break
      }
    } catch (err) {
      if (ac.signal.aborted) return
      console.warn('[voice-relay] LLM stream failed:', err?.message ?? err)
      this.send({
        type: 'text',
        token: 'দুঃখিত, একটু সমস্যা হচ্ছে। মালিক পরে আবার যোগাযোগ করবেন। আসসালামু আলাইকুম।',
        last: false,
      })
      sawEnd = true
    }

    this.send({ type: 'text', token: '', last: true })
    const spokenText = full.replace(END_MARKER, '').trim()
    if (spokenText) this.history.push({ role: 'assistant', text: spokenText })

    if (sawEnd && !this.ended) {
      this.ended = true
      // Give Twilio a beat to flush TTS of the goodbye before hanging up.
      setTimeout(() => this.send({ type: 'end' }), 4000)
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
    this.abort?.abort()
    if (this.reported) return
    this.reported = true
    await this.report().catch((err) =>
      console.warn('[voice-relay] report failed:', err?.message ?? err))
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

    let summary = null
    if (this.history.length) {
      try {
        const convoText = this.history
          .map((t) => `${t.role === 'assistant' ? 'এজেন্ট' : 'ব্যক্তি'}: ${t.text}`)
          .join('\n')
        const res = await this.genai.models.generateContent({
          model: RELAY_MODEL(),
          contents: `এই ফোন কথোপকথনের ২-৩ বাক্যের বাংলা সারাংশ লেখো (মূল তথ্য/সিদ্ধান্তসহ):\n\n${convoText}`,
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

    const res = await fetch(`${appUrl}/api/assistant/voice-call/relay-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        callRecordId: this.callRecordId,
        callSid: this.callSid,
        transcript,
        summary,
        durationSecs,
        status: this.history.length ? 'completed' : 'no_answer',
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`relay-report HTTP ${res.status}`)
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
      res.end(JSON.stringify({ ok: true, service: 'voice-relay', recentUpgrades }))
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
    if (url.pathname !== '/relay' || !verifyRelayToken(id, exp, t)) {
      const reason = url.pathname !== '/relay' ? `bad path ${url.pathname}` : 'token verify failed'
      noteUpgrade({ ok: false, reason, id: id ?? null, from })
      console.warn(`[voice-relay] upgrade rejected (${reason}) from ${from}`)
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    noteUpgrade({ ok: true, id, from })
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
