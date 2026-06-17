/**
 * Bangla-only voice constants — STT prompt + Google TTS voice (shared web + docs).
 */

/** Google Cloud TTS — production Bangla voice (Indian Bengali locale; best available on GCP). */
export const BANGLA_GOOGLE_TTS = {
  languageCode: 'bn-IN',
  name: 'bn-IN-Chirp3-HD-Charon',
} as const

/** Whisper prompt — API has no official `bn` code; steer away from Hindi auto-detect. */
export const WHISPER_BANGLA_PROMPT =
  'বাংলায় কথা বলা হচ্ছে। Bangladeshi Bangla and Banglish only — not Hindi, not Devanagari.'

/** Remove Devanagari / Gurmukhi script that causes Hindi-sounding TTS misreads. */
export function stripNonBanglaScripts(text: string): string {
  return text
    .replace(/[\u0900-\u097F]+/g, '') // Devanagari (Hindi)
    .replace(/[\u0A00-\u0A7F]+/g, '') // Gurmukhi
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Clean agent reply before Bangla TTS. */
export function prepareBanglaTtsText(text: string): string {
  return stripNonBanglaScripts(text)
}
