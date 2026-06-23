/**
 * Bangla voice-to-voice (STT) — shared by web orb + Telegram transcribe bridge.
 */

import type OpenAI from 'openai'

/** Steer the model away from Hindi auto-detect (Whisper had no official `bn` ISO code). */
export const WHISPER_BANGLA_PROMPT =
  'বাংলায় কথা বলা হচ্ছে। Bangladeshi Bangla and Banglish only — not Hindi, not Devanagari.'

/**
 * STT model. `whisper-1` (the old default) is notoriously poor at Bangladeshi
 * Bangla — it hallucinates Hindi-flavoured / garbled text even on clear speech,
 * which is exactly what the owner hit. `gpt-4o-transcribe` is dramatically more
 * accurate for Bangla and matches what ChatGPT/Gemini use, at the same ~$0.006/min.
 * Owner-tunable without redeploy via BANGLA_STT_MODEL.
 */
export const BANGLA_STT_MODEL = (process.env.BANGLA_STT_MODEL?.trim() || 'gpt-4o-transcribe')
/** Last-resort fallback if the primary model is unavailable on the account. */
const STT_FALLBACK_MODEL = 'whisper-1'

/** Google Cloud TTS voice used by default (cheap; owner ElevenLabs is opt-in only). */
export const BANGLA_GOOGLE_TTS = {
  languageCode: 'bn-IN',
  name: 'bn-IN-Chirp3-HD-Charon',
} as const

type WhisperFile = Parameters<OpenAI['audio']['transcriptions']['create']>[0]['file']

/**
 * Voice STT for Bangla. Tries the high-quality model first with an explicit `bn`
 * language hint (best accuracy), then degrades gracefully:
 *   1. gpt-4o-transcribe + language=bn   (best Bangla)
 *   2. gpt-4o-transcribe, no language    (in case a hint is rejected)
 *   3. whisper-1 + language=bn           (account fallback)
 * Returns the resolved model so callers can log cost against the right one.
 */
export async function transcribeVoiceBangla(
  client: OpenAI,
  file: WhisperFile,
): Promise<{ text: string; model: string }> {
  const base = {
    file,
    response_format: 'json' as const,
    prompt: WHISPER_BANGLA_PROMPT,
    temperature: 0,
  }

  // 1 — primary model, Bangla language hint.
  try {
    const r = await client.audio.transcriptions.create({
      ...base,
      model: BANGLA_STT_MODEL,
      language: 'bn',
    })
    return { text: r.text, model: BANGLA_STT_MODEL }
  } catch (errWithLang) {
    // 2 — same model without the language hint (some deployments reject `language`).
    try {
      const r = await client.audio.transcriptions.create({ ...base, model: BANGLA_STT_MODEL })
      return { text: r.text, model: BANGLA_STT_MODEL }
    } catch (errNoLang) {
      // 3 — fall back to whisper-1 only if the primary model itself is unavailable
      // (e.g. model-not-found / access). Other errors (auth, network) re-throw so
      // the route surfaces the real problem instead of silently degrading quality.
      const msg = errNoLang instanceof Error ? errNoLang.message : String(errNoLang)
      const modelUnavailable = /model|not.?found|does not exist|unsupported|404/i.test(msg)
      if (BANGLA_STT_MODEL !== STT_FALLBACK_MODEL && modelUnavailable) {
        const r = await client.audio.transcriptions.create({
          ...base,
          model: STT_FALLBACK_MODEL,
          language: 'bn',
        })
        return { text: r.text, model: STT_FALLBACK_MODEL }
      }
      throw errWithLang
    }
  }
}
