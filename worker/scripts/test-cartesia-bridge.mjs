/**
 * Cartesia bridge smoke test — run ON THE VPS after filling CARTESIA_API_KEY /
 * CARTESIA_VOICE_ID / OPENAI_API_KEY in worker/.env:
 *
 *   cd worker && node scripts/test-cartesia-bridge.mjs
 *
 * Verifies, without placing a phone call:
 *   1. Cartesia TTS websocket: synthesize a Bangla line in the configured voice
 *      as raw μ-law 8k (the exact telephony format the bridge streams to Twilio)
 *      and count the audio bytes.
 *   2. OpenAI Realtime STT: mint a transcription session (server VAD, bn) and
 *      open the websocket — proves the key + session config the bridge uses.
 * Both green = the bridge's external legs work; the remaining risk is only the
 * public wss exposure (Caddy) and Twilio itself.
 */

import 'dotenv/config'
import { WebSocket } from 'ws'
import { randomUUID } from 'crypto'

const CARTESIA_VERSION = '2026-03-01'
const MODEL = process.env.CARTESIA_TTS_MODEL || 'sonic-3'
const LINE = 'আসসালামু আলাইকুম, আমি মালিকের ব্যক্তিগত সহকারী বলছি। এটা একটা পরীক্ষামূলক বাক্য।'

function fail(step, err) {
  console.error(`✗ ${step}: ${err?.message ?? err}`)
  process.exitCode = 1
}

async function testCartesiaTts() {
  if (!process.env.CARTESIA_API_KEY) return fail('cartesia', 'CARTESIA_API_KEY not set')
  if (!process.env.CARTESIA_VOICE_ID) return fail('cartesia', 'CARTESIA_VOICE_ID not set')
  await new Promise((resolve) => {
    const ws = new WebSocket(`wss://api.cartesia.ai/tts/websocket?cartesia_version=${CARTESIA_VERSION}`, {
      headers: { 'X-API-Key': process.env.CARTESIA_API_KEY },
    })
    const ctx = randomUUID()
    let bytes = 0
    const to = setTimeout(() => { fail('cartesia', 'timeout (20s)'); try { ws.close() } catch { /* noop */ } resolve() }, 20_000)
    ws.on('open', () => {
      ws.send(JSON.stringify({
        model_id: MODEL,
        voice: { mode: 'id', id: process.env.CARTESIA_VOICE_ID },
        language: 'bn',
        output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
        transcript: LINE,
        context_id: ctx,
        continue: false,
      }))
    })
    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.type === 'chunk' && msg.data) bytes += Buffer.from(msg.data, 'base64').length
      if (msg.type === 'done') {
        clearTimeout(to)
        const secs = (bytes / 8000).toFixed(1)
        if (bytes > 8000) console.log(`✓ cartesia TTS (${MODEL}, bn): ${bytes} μ-law bytes ≈ ${secs}s audio`)
        else fail('cartesia', `only ${bytes} audio bytes — check voice id / language support`)
        ws.close(); resolve()
      }
      if (msg.type === 'error') {
        clearTimeout(to); fail('cartesia', JSON.stringify(msg).slice(0, 200)); ws.close(); resolve()
      }
    })
    ws.on('error', (err) => { clearTimeout(to); fail('cartesia ws', err); resolve() })
  })
}

async function testOpenAiStt() {
  if (!process.env.OPENAI_API_KEY) return fail('openai', 'OPENAI_API_KEY not set')
  let key
  try {
    const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: 120 },
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              transcription: { model: process.env.BANGLA_STT_MODEL || 'gpt-4o-transcribe', language: 'bn' },
              turn_detection: { type: 'server_vad', silence_duration_ms: 900 },
            },
          },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return fail('openai mint', `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const data = await res.json()
    key = data.value ?? data.client_secret?.value
    if (!key) return fail('openai mint', 'no ephemeral key in response')
  } catch (err) {
    return fail('openai mint', err)
  }
  await new Promise((resolve) => {
    const ws = new WebSocket('wss://api.openai.com/v1/realtime', ['realtime', `openai-insecure-api-key.${key}`])
    const to = setTimeout(() => { fail('openai ws', 'timeout (10s)'); try { ws.close() } catch { /* noop */ } resolve() }, 10_000)
    ws.on('open', () => {
      clearTimeout(to)
      console.log('✓ openai realtime STT session (server VAD, bn) connects')
      ws.close(); resolve()
    })
    ws.on('error', (err) => { clearTimeout(to); fail('openai ws', err); resolve() })
  })
}

console.log('Cartesia bridge smoke test…')
await testCartesiaTts()
await testOpenAiStt()
console.log(process.exitCode ? '→ FIX the ✗ items before flipping VOICE_CALL_PROVIDER=cartesia' : '→ all green, bridge legs OK')
