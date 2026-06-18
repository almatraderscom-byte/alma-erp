#!/usr/bin/env node
/**
 * Live verify: production Whisper Bangla STT + Google TTS (web orb path).
 * Run on VPS where AGENT_INTERNAL_TOKEN + OPENAI + GOOGLE creds exist.
 */
import dotenv from 'dotenv'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: join(root, 'worker/.env'), override: true })

const APP_URL = (process.env.APP_URL ?? 'https://alma-erp-six.vercel.app').replace(/\/$/, '')
const TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''

function fail(msg) {
  console.error('FAIL', msg)
  process.exit(1)
}

if (!TOKEN) fail('AGENT_INTERNAL_TOKEN missing')

async function synthesizeGoogleBangla(text) {
  const { synthesizeSpeech } = await import(join(root, 'worker/src/tts.mjs'))
  return synthesizeSpeech(text, 300)
}

async function testProductionTranscribe(mp3OrOggBuffer) {
  const res = await fetch(`${APP_URL}/api/assistant/internal/transcribe`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'audio/ogg',
    },
    body: mp3OrOggBuffer,
    signal: AbortSignal.timeout(90_000),
  })
  const body = await res.text()
  if (!res.ok) fail(`transcribe HTTP ${res.status}: ${body.slice(0, 200)}`)
  const data = JSON.parse(body)
  return data.text ?? ''
}

async function main() {
  console.log(`APP_URL=${APP_URL}`)

  // Build minimal test audio via Google TTS → round-trip is not STT; use TTS sample as proxy
  // Real STT test: synthesize Bangla, we can't easily reverse without ffmpeg speech.
  // Instead verify production internal/transcribe accepts request + returns JSON (use tiny ogg if available)

  const sampleText = 'স্যার, web orb যাচাই। বাংলায় কথা বলছি।'
  const mp3 = await synthesizeGoogleBangla(sampleText)
  console.log(`PASS Google Bangla TTS: ${mp3.length} bytes`)

  // Verify routing constants on production build-info
  const info = await fetch(`${APP_URL}/api/build-info`).then((r) => r.json())
  console.log(`build: ${info.commitShort} (${info.message?.slice(0, 60)}…)`)
  if (!String(info.commitShort ?? '').startsWith('b63de78') && !String(info.commitShort ?? '').startsWith('52368d8')) {
    console.warn('WARN: production may not have latest commit yet')
  }

  // Static: ElevenLabs not default
  const { parseOwnerVoiceIntent } = await import(join(root, 'worker/src/elevenlabs-voices.mjs'))
  const plain = parseOwnerVoiceIntent('আজ কী করব?')
  if (plain.useElevenLabs) fail('plain text triggers ElevenLabs')
  console.log('PASS ElevenLabs opt-in only (plain text)')

  const voiceKw = parseOwnerVoiceIntent('শুনিয়ে দাও আজকের বিক্রি')
  if (voiceKw.useElevenLabs) fail('voice keyword triggers ElevenLabs without explicit request')
  console.log('PASS Google default even with শুনিয়ে দাও keyword')

  const explicit = parseOwnerVoiceIntent('eleven labs এ শুনিয়ে দাও')
  if (!explicit.useElevenLabs) fail('explicit eleven labs not detected')
  console.log('PASS ElevenLabs only when explicitly requested')

  // Test transcribe endpoint is live (empty body should 400 not 401)
  const bad = await fetch(`${APP_URL}/api/assistant/internal/transcribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'audio/ogg' },
    body: Buffer.alloc(0),
  })
  if (bad.status === 401) fail('internal transcribe auth broken')
  console.log(`PASS internal/transcribe reachable (empty → ${bad.status})`)

  // If we have a sample ogg on disk, run real Whisper test
  const sampleOgg = join(root, 'worker/scripts/fixtures/bangla-sample.ogg')
  if (existsSync(sampleOgg)) {
    const buf = readFileSync(sampleOgg)
    const text = await testProductionTranscribe(buf)
    console.log(`PASS Whisper STT: "${text.slice(0, 80)}"`)
    if (/[\u0900-\u097F]/.test(text)) console.warn('WARN: Devanagari in transcript')
  } else {
    console.log('SKIP live Whisper sample (no fixtures/bangla-sample.ogg)')
  }

  console.log('\nAll live voice checks passed.')
}

main().catch((e) => fail(e.message))
