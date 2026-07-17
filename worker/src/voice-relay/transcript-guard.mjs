/**
 * Heard-it-wrong guard for live two-way calls — pure, dependency-free, testable.
 *
 * Live proof (prod `agent_voice_calls`, 2026-06-27): the caller spoke BANGLA and the
 * ASR returned HINDI DEVANAGARI — "आपकी जानकारी के लिए बहुत बहुत।", "हाँ, नहीं, हम दोनों
 * जगह पर…". The relay handed that text straight to the model, which answered it as if
 * it were real and then carried on by itself. That is the owner's
 * "amar kotha na bujhei nijer moto kotha bola".
 *
 * Devanagari (U+0900–U+097F) and Bangla (U+0980–U+09FF) are disjoint Unicode blocks,
 * so a mis-recognised script is detectable with certainty — no model needed.
 */

const DEVANAGARI_RE = /[ऀ-ॿ]/
const BANGLA_RE = /[ঀ-৿]/
const LATIN_RE = /[A-Za-z]/

/**
 * True when a transcript must NOT be answered: wrong script, or too thin to carry
 * meaning. The caller then asks the person to repeat instead of letting the model
 * invent a reply to garbage.
 */
export function isUnintelligibleTranscript(raw) {
  const t = String(raw ?? '').trim()
  if (!t) return true
  // Devanagari with no Bangla → the ASR heard Hindi. Bangla speech is never Hindi.
  if (DEVANAGARI_RE.test(t) && !BANGLA_RE.test(t)) return true
  // No Bangla and no Latin letters at all → punctuation/noise only.
  if (!BANGLA_RE.test(t) && !LATIN_RE.test(t)) return true
  // A lone stray character is noise, not speech ("।", "a").
  if (t.replace(/[\s।.,!?-]/g, '').length < 2) return true
  return false
}
