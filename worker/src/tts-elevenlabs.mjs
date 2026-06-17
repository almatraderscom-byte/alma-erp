/**
 * ElevenLabs TTS — match playground quality as closely as possible.
 *
 * Quality gaps vs ElevenLabs website were caused by:
 *  1. Telegram sendVoice re-encodes to low-bitrate OGG (fixed in voice.mjs → sendAudio)
 *  2. Over-aggressive text prep (transliterating English → awkward Bangla)
 *  3. Missing output_format=mp3_44100_128 on API URL
 */
import { logCost } from './cost-log.mjs'
import { stripMarkdown } from './tts.mjs'

const ELEVENLABS_API_KEY = () => process.env.ELEVENLABS_API_KEY ?? ''
const ELEVENLABS_VOICE_ID = () => process.env.ELEVENLABS_VOICE_ID ?? 'pNInz6obpgDQGcFmaJgB'
const ELEVENLABS_MODEL_ID = () => process.env.ELEVENLABS_MODEL_ID ?? 'eleven_multilingual_v2'
const ELEVENLABS_OUTPUT_FORMAT = () => process.env.ELEVENLABS_OUTPUT_FORMAT ?? 'mp3_44100_128'

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1'
/** ElevenLabs multilingual v2 — single request up to ~5000 chars */
const MAX_CHARS_PER_REQUEST = 4500

/**
 * Minimal prep — playground sends text as typed; only strip markdown/noise.
 */
export function prepareBanglaForElevenLabs(text) {
  return stripMarkdown(text).replace(/\s{2,}/g, ' ').trim().slice(0, MAX_CHARS_PER_REQUEST)
}

function voiceSettings(opts = {}) {
  const stability = opts.stability ?? Number(process.env.ELEVENLABS_STABILITY ?? 0.62)
  const similarity = opts.similarity_boost ?? opts.similarity ?? Number(process.env.ELEVENLABS_SIMILARITY_BOOST ?? 0.8)
  return {
    stability,
    similarity_boost: similarity,
    style: opts.style ?? 0.0,
    use_speaker_boost: opts.use_speaker_boost !== false,
  }
}

async function synthesizeChunk(preparedText, opts = {}) {
  const apiKey = ELEVENLABS_API_KEY()
  const voiceId = opts.voiceId ?? ELEVENLABS_VOICE_ID()
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set')
  if (!voiceId) throw new Error('ELEVENLABS_VOICE_ID not set')
  if (!preparedText) throw new Error('No text to synthesize')

  const body = {
    text: preparedText,
    model_id: ELEVENLABS_MODEL_ID(),
    voice_settings: voiceSettings(opts),
  }

  const format = ELEVENLABS_OUTPUT_FORMAT()
  const url = `${ELEVENLABS_BASE}/text-to-speech/${voiceId}?output_format=${encodeURIComponent(format)}`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`ElevenLabs TTS error ${res.status}: ${errText.slice(0, 200)}`)
  }

  return Buffer.from(await res.arrayBuffer())
}

/**
 * Synthesize speech using owner's cloned voice on ElevenLabs.
 * @param {string} text  Bengali text (avoid English words in the string)
 * @param {{ stability?: number, similarity?: number, similarity_boost?: number }} [opts]
 * @returns {Promise<Buffer>}  MP3 audio buffer
 */
export async function synthesizeElevenLabs(text, opts = {}) {
  const prepared = prepareBanglaForElevenLabs(text)
  if (!prepared) throw new Error('No text to synthesize')

  // Single request — avoids broken MP3 concat; matches playground behaviour
  const buffer = await synthesizeChunk(prepared, opts)

  void logCost({
    provider: 'elevenlabs',
    kind: 'tts',
    units: { characters: prepared.length, voice: ELEVENLABS_VOICE_ID(), model: ELEVENLABS_MODEL_ID() },
    costUsd: estimateElevenLabsCost(prepared.length),
    dedupKey: `elevenlabs:${prepared.length}:${prepared.slice(0, 24)}`,
  })

  return buffer
}

function estimateElevenLabsCost(chars) {
  return (chars / 1000) * 0.30
}

export function isElevenLabsAvailable() {
  return Boolean(ELEVENLABS_API_KEY() && ELEVENLABS_VOICE_ID())
}

export async function smartTts(text, opts = {}) {
  if (opts.elevenLabsOnly) {
    if (!isElevenLabsAvailable()) {
      throw new Error('ElevenLabs required but ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID not set')
    }
    return synthesizeElevenLabs(text)
  }

  if (opts.useOwnerVoice && isElevenLabsAvailable()) {
    return synthesizeElevenLabs(text)
  }

  const { synthesizeSpeech } = await import('./tts.mjs')
  return synthesizeSpeech(text)
}
