/**
 * Bangla voice-to-voice (Whisper STT) — shared by web orb + Telegram transcribe bridge.
 */

import type OpenAI from 'openai'

/** Steer Whisper away from Hindi auto-detect (API has no official `bn` ISO code). */
export const WHISPER_BANGLA_PROMPT =
  'বাংলায় কথা বলা হচ্ছে। Bangladeshi Bangla and Banglish only — not Hindi, not Devanagari.'

/** Google Cloud TTS voice used by default (cheap; owner ElevenLabs is opt-in only). */
export const BANGLA_GOOGLE_TTS = {
  languageCode: 'bn-IN',
  name: 'bn-IN-Chirp3-HD-Charon',
} as const

type WhisperFile = Parameters<OpenAI['audio']['transcriptions']['create']>[0]['file']

/**
 * Voice-to-voice STT: prefer Bengali language hint, fall back to prompt-only.
 */
export async function transcribeVoiceBangla(
  client: OpenAI,
  file: WhisperFile,
): Promise<{ text: string }> {
  const base = {
    file,
    model: 'whisper-1' as const,
    response_format: 'json' as const,
    prompt: WHISPER_BANGLA_PROMPT,
    temperature: 0,
  }

  try {
    return await client.audio.transcriptions.create({ ...base, language: 'bn' })
  } catch {
    return await client.audio.transcriptions.create(base)
  }
}
