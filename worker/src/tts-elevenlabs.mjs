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
import { resolveVoiceId } from './elevenlabs-voices.mjs'

const ELEVENLABS_API_KEY = () => process.env.ELEVENLABS_API_KEY ?? ''
const ELEVENLABS_MODEL_ID = () => process.env.ELEVENLABS_MODEL_ID ?? 'eleven_v3'
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
  const model = ELEVENLABS_MODEL_ID()
  // eleven_v3: stability 0.0 | 0.5 | 1.0 only; multilingual_v2: 0.0–1.0 continuous
  const defaultStability = model === 'eleven_v3' ? 0.5 : 0.62
  const defaultSimilarity = model === 'eleven_v3' ? 0.75 : 0.8
  const stability = opts.stability ?? Number(process.env.ELEVENLABS_STABILITY ?? defaultStability)
  const similarity = opts.similarity_boost ?? opts.similarity ?? Number(process.env.ELEVENLABS_SIMILARITY_BOOST ?? defaultSimilarity)
  const settings = {
    stability,
    similarity_boost: similarity,
    use_speaker_boost: opts.use_speaker_boost !== false,
  }
  if (model !== 'eleven_v3') {
    settings.style = opts.style ?? 0.0
  }
  return settings
}

async function synthesizeChunk(preparedText, opts = {}) {
  const apiKey = ELEVENLABS_API_KEY()
  const voiceId = opts.voiceId ?? resolveVoiceId(opts.voiceProfile ?? 'staff')
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set')
  if (!voiceId) throw new Error('ElevenLabs voice ID not configured for profile')
  if (!preparedText) throw new Error('No text to synthesize')

  const body = {
    text: preparedText,
    model_id: ELEVENLABS_MODEL_ID(),
    voice_settings: voiceSettings(opts),
    language_code: 'ben',
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

  const purpose = opts.purpose ?? 'voice_message'
  void logCost({
    provider: 'elevenlabs',
    kind: 'tts',
    units: {
      characters: prepared.length,
      voice: opts.voiceId ?? resolveVoiceId(opts.voiceProfile ?? 'staff'),
      model: ELEVENLABS_MODEL_ID(),
      profile: opts.voiceProfile ?? 'staff',
      purpose,
    },
    costUsd: estimateElevenLabsCost(prepared.length),
    dedupKey: `elevenlabs:${purpose}:${prepared.length}:${prepared.slice(0, 24)}`,
  })

  return buffer
}

function estimateElevenLabsCost(chars) {
  return (chars / 1000) * 0.30
}

export function isElevenLabsAvailable() {
  return Boolean(ELEVENLABS_API_KEY())
}

export async function smartTts(text, opts = {}) {
  const profile = opts.voiceProfile ?? (opts.elevenLabsOnly ? 'staff' : 'male')
  const purpose = opts.purpose ?? 'voice_message'

  if (opts.isSalah) {
    const { synthesizeSpeech } = await import('./tts.mjs')
    return synthesizeSpeech(text, 600, { purpose: 'salah_voice' })
  }

  const wantsElevenLabs =
    Boolean(opts.elevenLabsOnly || opts.useElevenLabs) && !opts.useGoogleBangla

  if (wantsElevenLabs) {
    if (!isElevenLabsAvailable()) {
      console.warn('[smartTts] ElevenLabs requested but unavailable — falling back to Google Bangla TTS')
    } else {
      return synthesizeElevenLabs(text, { voiceProfile: profile, purpose })
    }
  }

  const { synthesizeSpeech } = await import('./tts.mjs')
  return synthesizeSpeech(text, 600, { purpose })
}
