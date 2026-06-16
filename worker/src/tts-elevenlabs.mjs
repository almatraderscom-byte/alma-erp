/**
 * ElevenLabs TTS — Owner's cloned voice for staff communication.
 * Used when:
 *  - Sending voice messages to staff (task dispatch, reminders)
 *  - Owner explicitly requests "say in my voice"
 *
 * Google TTS (bn-IN-Chirp3-HD-Charon) remains for Salah reminders.
 * Plan: ElevenLabs Starter (75 min/month).
 */
import { logCost } from './cost-log.mjs'
import { splitTextForTts } from './tts.mjs'

const ELEVENLABS_API_KEY = () => process.env.ELEVENLABS_API_KEY ?? ''
const ELEVENLABS_VOICE_ID = () => process.env.ELEVENLABS_VOICE_ID ?? ''

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1'

/**
 * Synthesize speech using owner's cloned voice on ElevenLabs.
 * @param {string} text  Text to speak (Bengali or English)
 * @param {{ stability?: number, similarity?: number, style?: number }} [opts]
 * @returns {Promise<Buffer>}  MP3 audio buffer
 */
export async function synthesizeElevenLabs(text, opts = {}) {
  const apiKey = ELEVENLABS_API_KEY()
  const voiceId = ELEVENLABS_VOICE_ID()
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set')
  if (!voiceId) throw new Error('ELEVENLABS_VOICE_ID not set')

  const cleaned = text.replace(/#{1,6}\s+/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`[^`]*`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim()
    .slice(0, 1000)

  if (!cleaned) throw new Error('No text to synthesize')

  const res = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
    },
    body: JSON.stringify({
      text: cleaned,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: opts.stability ?? 0.5,
        similarity_boost: opts.similarity ?? 0.8,
        style: opts.style ?? 0.3,
        use_speaker_boost: true,
      },
    }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`ElevenLabs TTS error ${res.status}: ${errText.slice(0, 200)}`)
  }

  const buffer = Buffer.from(await res.arrayBuffer())

  void logCost({
    provider: 'elevenlabs',
    kind: 'tts',
    units: { characters: cleaned.length, voice: voiceId },
    costUsd: estimateElevenLabsCost(cleaned.length),
    dedupKey: `elevenlabs:${cleaned.length}:${cleaned.slice(0, 24)}`,
  })

  return buffer
}

function estimateElevenLabsCost(chars) {
  return (chars / 1000) * 0.30
}

/**
 * Check if ElevenLabs is configured and available.
 */
export function isElevenLabsAvailable() {
  return Boolean(ELEVENLABS_API_KEY() && ELEVENLABS_VOICE_ID())
}

/**
 * Smart TTS — uses ElevenLabs for staff/owner voice, falls back to Google.
 * @param {string} text
 * @param {{ useOwnerVoice?: boolean }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function smartTts(text, opts = {}) {
  if (opts.useOwnerVoice && isElevenLabsAvailable()) {
    return synthesizeElevenLabs(text)
  }

  const { synthesizeSpeech } = await import('./tts.mjs')
  return synthesizeSpeech(text)
}
