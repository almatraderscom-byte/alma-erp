/**
 * Sarvam Bulbul TTS (Bangla) for ONE-WAY calls → 8 kHz mono WAV buffer.
 *
 * The two-way pipeline (voice-relay/sarvam-media.mjs) proved Sarvam's Bangla is
 * clearly more natural than Google's bn-IN Charon (Indian-Bangla accent), so one-way
 * announcement calls now default to Sarvam too (owner decision 2026-07-18). This
 * mirrors that pipeline's EXACT, live-verified request: bulbul:v2, speaker anushka,
 * bn-IN, 8 kHz, `api-subscription-key` auth, base64 WAV returned in `audios[0]`.
 *
 * The caller (notify/twilio-call.mjs) runs the returned buffer through
 * mp3ToTelephonyWav — ffmpeg sniffs the container and ignores the `.mp3` tmp name, so
 * returning WAV is fine; it gets normalised to Twilio's 8 kHz mono anyway.
 *
 * Secrets are env-only (SARVAM_API_KEY) — no key is ever hard-coded.
 */
import { logCost } from './cost-log.mjs'
import { stripMarkdown, splitTextForTts } from './tts.mjs'

const SARVAM_TTS_URL = 'https://api.sarvam.ai/text-to-speech'
const TTS_MODEL = () => process.env.SARVAM_TTS_MODEL || 'bulbul:v2'
const DEFAULT_SPEAKER = () => process.env.SARVAM_TTS_SPEAKER || 'anushka'
const LANG = () => process.env.VOICE_RELAY_STT_LANGUAGE || 'bn-IN'
const SARVAM_KEY = () => process.env.SARVAM_API_KEY || ''

/** bulbul:v2 = ₹15 / 10k chars. ₹→USD ~0.012 just for the cost log. */
const SARVAM_TTS_INR_PER_10K = 15
const INR_TO_USD = 0.012

/** Per-request cap — matches the two-way pipeline's proven `text.slice(0, 400)`. */
const MAX_CHARS_PER_REQUEST = 400

export function isSarvamAvailable() {
  return Boolean(SARVAM_KEY())
}

/** Strip a RIFF/WAV header → raw PCM (so multiple chunks concat without mid-stream headers). */
function wavToPcm16(buf) {
  if (buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF') {
    let off = 12
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4)
      const size = buf.readUInt32LE(off + 4)
      if (id === 'data') return buf.subarray(off + 8, off + 8 + size)
      off += 8 + size + (size & 1)
    }
    return buf.subarray(44)
  }
  return buf
}

/** Wrap PCM16 mono → a single WAV so the whole message plays as one clean clip. */
function pcm16ToWav(pcm, sampleRate = 8000) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)              // PCM
  header.writeUInt16LE(1, 22)              // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate = sampleRate * blockAlign
  header.writeUInt16LE(2, 32)              // block align (mono, 16-bit)
  header.writeUInt16LE(16, 34)             // bits/sample
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

async function synthChunk(text, speaker, model) {
  const res = await fetch(SARVAM_TTS_URL, {
    method: 'POST',
    headers: { 'api-subscription-key': SARVAM_KEY(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      target_language_code: LANG(),
      model,
      speaker,
      speech_sample_rate: 8000,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || !j.audios?.[0]) {
    throw new Error(`Sarvam TTS ${res.status}: ${JSON.stringify(j).slice(0, 160)}`)
  }
  return Buffer.from(j.audios[0], 'base64')
}

/**
 * Synthesize a Bangla message with Sarvam Bulbul → one 8 kHz mono WAV buffer.
 * @param {string} text  Bangla text (markdown stripped internally)
 * @param {{ speaker?: string, purpose?: string }} [opts]
 * @returns {Promise<Buffer>}  WAV buffer
 */
export async function synthesizeSarvam(text, opts = {}) {
  if (!isSarvamAvailable()) throw new Error('SARVAM_API_KEY not set')
  const speaker = opts.speaker || DEFAULT_SPEAKER()
  const model = opts.model || TTS_MODEL()   // speaker + model travel together (v2/v3 speakers differ)
  const cleaned = stripMarkdown(text)
  if (!cleaned) throw new Error('No text to synthesize')

  // splitTextForTts strips markdown itself; chunks stay well under the bulbul cap.
  const chunks = splitTextForTts(text, MAX_CHARS_PER_REQUEST)
  if (chunks.length === 0) throw new Error('No text to synthesize')

  const pcmParts = []
  for (const chunk of chunks) {
    const wav = await synthChunk(chunk, speaker, model)
    pcmParts.push(wavToPcm16(wav))
  }
  const out = pcm16ToWav(Buffer.concat(pcmParts), 8000)

  const purpose = opts.purpose ?? 'phone_call'
  void logCost({
    provider: 'sarvam_tts',
    kind: 'tts',
    units: { characters: cleaned.length, voice: speaker, model, purpose },
    costUsd: (cleaned.length / 10000) * (/v3/.test(model) ? 30 : SARVAM_TTS_INR_PER_10K) * INR_TO_USD,
    dedupKey: `sarvam_tts:${purpose}:${cleaned.length}:${cleaned.slice(0, 24)}`,
  })
  return out
}
