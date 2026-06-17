#!/usr/bin/env node
/**
 * Phase K — Bangla-only voice path verification (static + optional live TTS).
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: join(root, 'worker/.env'), override: true })

function read(rel) {
  return readFileSync(join(root, rel), 'utf8')
}

function assert(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

// ── Static routing checks ───────────────────────────────────────────────────

const voicesSrc = read('worker/src/elevenlabs-voices.mjs')
assert(
  'parseOwnerVoiceIntent does not force ElevenLabs on every voice request',
  !voicesSrc.includes('useElevenLabs: useElevenLabs || wantsVoice'),
)

const agentTurn = read('worker/src/telegram/agent-turn.mjs')
assert(
  'agent-turn uses explicit useElevenLabs only',
  agentTurn.includes('useElevenLabs: Boolean(useElevenLabs)'),
  'no isElevenLabsAvailable() default',
)
assert(
  'agent-turn does not default ElevenLabs when available',
  !agentTurn.includes('useElevenLabs || isElevenLabsAvailable()'),
)

const voiceMjs = read('worker/src/telegram/voice.mjs')
assert(
  'sendVoiceMessage does not route useOwnerVoice to ElevenLabs',
  !voiceMjs.includes('options.useOwnerVoice)'),
)

const smartTts = read('worker/src/tts-elevenlabs.mjs')
assert(
  'smartTts defaults to Google (no useOwnerVoice → ElevenLabs)',
  !smartTts.includes('opts.useOwnerVoice && isElevenLabsAvailable()'),
)
assert('ElevenLabs uses language_code ben', smartTts.includes("language_code: 'ben'"))

const indexMjs = read('worker/src/telegram/index.mjs')
assert(
  'Telegram voice notes auto-reply with voice',
  indexMjs.includes('fromVoiceNote: true'),
)

const transcribe = read('src/app/api/assistant/transcribe/route.ts')
assert('Web transcribe uses WHISPER_BANGLA_PROMPT', transcribe.includes('WHISPER_BANGLA_PROMPT'))

const ttsRoute = read('src/app/api/assistant/tts/route.ts')
assert('Web TTS uses bn-IN Charon', ttsRoute.includes('BANGLA_GOOGLE_TTS'))
assert('Web TTS strips non-Bangla scripts', ttsRoute.includes('prepareBanglaTtsText'))

// ── Devanagari strip ────────────────────────────────────────────────────────

const { stripNonBanglaScripts } = await import(join(root, 'worker/src/voice-bangla.mjs'))
const devanagari = '\u0928\u092E\u0938\u094D\u0924\u0947'
const mixed = `\u0986\u09B8\u09B8\u09BE\u09B2\u09BE\u09AE\u09C1 \u0986\u09B2\u09BE\u0987\u0995\u09C1\u09AE ${devanagari} \u09B8\u09CD\u09AF\u09BE\u09B0`
const stripped = stripNonBanglaScripts(mixed)
assert(
  'stripNonBanglaScripts removes Devanagari',
  !/[\u0900-\u097F]/.test(stripped),
  stripped,
)

// ── parseOwnerVoiceIntent runtime ───────────────────────────────────────────

const { parseOwnerVoiceIntent } = await import(join(root, 'worker/src/elevenlabs-voices.mjs'))

const voiceNoteReply = parseOwnerVoiceIntent('\u0986\u099C\u0995\u09C7\u09B0 \u09AC\u09BF\u0995\u09CD\u09B0\u09BF \u0995\u09A4?')
assert(
  'plain Bangla text does not trigger ElevenLabs',
  voiceNoteReply.useElevenLabs === false,
)

const explicitEl = parseOwnerVoiceIntent('eleven labs female voice \u098F \u09AC\u09B2\u09CB')
assert('explicit ElevenLabs request detected', explicitEl.useElevenLabs === true)

// ── Optional live Google TTS ─────────────────────────────────────────────────

if (process.env.GOOGLE_TTS_CREDENTIALS) {
  const { synthesizeSpeech } = await import(join(root, 'worker/src/tts.mjs'))
  const sample = '\u09B8\u09CD\u09AF\u09BE\u09B0, \u0986\u09AE\u09BF \u09AC\u09BE\u0982\u09B2\u09BE\u09AF\u09BC \u0995\u09A5\u09BE \u09AC\u09B2\u099B\u09BF\u0964'
  try {
    const buf = await synthesizeSpeech(sample, 200)
    assert('Google Bangla TTS synthesizes MP3', buf.length > 1000, `${buf.length} bytes`)
  } catch (err) {
    assert('Google Bangla TTS synthesizes MP3', false, err.message)
  }
} else {
  console.log('SKIP live Google TTS — GOOGLE_TTS_CREDENTIALS not in worker/.env')
}

console.log('\nDone.')
