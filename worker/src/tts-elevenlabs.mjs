/**
 * ElevenLabs TTS — Owner's cloned voice for staff communication.
 *
 * Bangla quality depends on:
 *  1. Pure Bengali script in `text` (no English words — model reads Latin as English)
 *  2. language_code + text normalization
 *  3. Higher stability / similarity for consistent pronunciation
 */
import { logCost } from './cost-log.mjs'
import { splitTextForTts, stripMarkdown } from './tts.mjs'

const ELEVENLABS_API_KEY = () => process.env.ELEVENLABS_API_KEY ?? ''
const ELEVENLABS_VOICE_ID = () => process.env.ELEVENLABS_VOICE_ID ?? ''
const ELEVENLABS_MODEL_ID = () => process.env.ELEVENLABS_MODEL_ID ?? 'eleven_multilingual_v2'

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1'

/** Latin → Bengali script for words that often appear in staff/owner messages. */
const LATIN_WORD_MAP = [
  [/telegram/gi, 'টেলিগ্রাম'],
  [/whatsapp/gi, 'হোয়াটসঅ্যাপ'],
  [/facebook/gi, 'ফেসবুক'],
  [/messenger/gi, 'মেসেঞ্জার'],
  [/boost/gi, 'বুস্ট'],
  [/order/gi, 'অর্ডার'],
  [/task/gi, 'টাস্ক'],
  [/proof/gi, 'প্রুফ'],
  [/office/gi, 'অফিস'],
  [/sir/gi, 'স্যার'],
  [/boss/gi, 'বস'],
  [/ok\b/gi, 'ঠিক আছে'],
  [/okay\b/gi, 'ঠিক আছে'],
  [/sms/gi, 'এসএমএস'],
  [/api/gi, 'এপিআই'],
  [/erp/gi, 'ইআরপি'],
]

function toBengaliDigits(text) {
  return text.replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)])
}

/**
 * Prepare text so ElevenLabs stays in Bangla — Latin words trigger English pronunciation.
 */
export function prepareBanglaForElevenLabs(text) {
  let out = stripMarkdown(text)
  for (const [re, bn] of LATIN_WORD_MAP) {
    out = out.replace(re, bn)
  }
  out = toBengaliDigits(out)
  // Drop bare URLs/emails — TTS reads them as gibberish/English
  out = out.replace(/https?:\/\/\S+/gi, '')
  out = out.replace(/\S+@\S+\.\S+/g, '')
  out = out.replace(/\s{2,}/g, ' ').trim()
  return out.slice(0, 1000)
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
  const voiceId = ELEVENLABS_VOICE_ID()
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set')
  if (!voiceId) throw new Error('ELEVENLABS_VOICE_ID not set')
  if (!preparedText) throw new Error('No text to synthesize')

  const body = {
    text: preparedText,
    model_id: ELEVENLABS_MODEL_ID(),
    voice_settings: voiceSettings(opts),
  }

  const res = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voiceId}`, {
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

  const chunks = splitTextForTts(prepared, 220)
  const buffers = []
  for (const chunk of chunks) {
    buffers.push(await synthesizeChunk(chunk, opts))
  }
  const buffer = Buffer.concat(buffers)

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
