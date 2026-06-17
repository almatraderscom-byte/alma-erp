/**
 * Bangla-only voice constants (worker mirror of src/agent/lib/voice-bangla.ts).
 */

export const BANGLA_GOOGLE_TTS = {
  languageCode: 'bn-IN',
  name: 'bn-IN-Chirp3-HD-Charon',
}

export const WHISPER_BANGLA_PROMPT =
  'বাংলায় কথা বলা হচ্ছে। Bangladeshi Bangla and Banglish only — not Hindi, not Devanagari.'

export function stripNonBanglaScripts(text) {
  return String(text ?? '')
    .replace(/[\u0900-\u097F]+/g, '')
    .replace(/[\u0A00-\u0A7F]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function prepareBanglaTtsText(text) {
  return stripNonBanglaScripts(text)
}
