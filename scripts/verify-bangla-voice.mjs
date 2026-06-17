#!/usr/bin/env node
/**
 * Voice routing verify — Google TTS default; ElevenLabs opt-in only; Whisper Bangla STT.
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
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

assert(
  'ElevenLabs not forced on every voice keyword',
  !read('worker/src/elevenlabs-voices.mjs').includes('useElevenLabs: useElevenLabs || wantsVoice'),
)
assert(
  'agent-turn: explicit ElevenLabs only',
  read('worker/src/telegram/agent-turn.mjs').includes('useElevenLabs: Boolean(useElevenLabs)'),
)
assert(
  'Telegram voice notes: preview flow (no fromVoiceNote)',
  !read('worker/src/telegram/index.mjs').includes('fromVoiceNote'),
)
assert(
  'Whisper voice-to-voice helper',
  read('src/agent/lib/voice-bangla.ts').includes('transcribeVoiceBangla'),
)
assert(
  'Web orb transcribe uses helper',
  read('src/app/api/assistant/transcribe/route.ts').includes('transcribeVoiceBangla'),
)

const { parseOwnerVoiceIntent } = await import(join(root, 'worker/src/elevenlabs-voices.mjs'))
assert('plain text → no ElevenLabs', parseOwnerVoiceIntent('আজকের বিক্রি কত?').useElevenLabs === false)
assert('eleven labs explicit → yes', parseOwnerVoiceIntent('eleven labs এ বলো').useElevenLabs === true)

console.log('\nDone.')
