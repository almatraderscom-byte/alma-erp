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

/**
 * Does the caller's own speech clearly signal they want to END the call?
 *
 * The relay must NEVER hang up on its own — the owner's "auto kete gese, ami kati ni"
 * was the model deciding the purpose was done and emitting the end marker. We only
 * honour that marker when the HUMAN actually said goodbye. Bangla + Banglish closings
 * only; a bare "ধন্যবাদ"/"accha" is NOT an ending (conversation often continues after).
 */
const END_SIGNAL_RE = new RegExp(
  [
    'বিদায়',
    '(?:আল্লাহ্?|খোদা|খুদা)\\s*হাফেজ',
    'রাখছি',
    'রাখলাম',
    // "এখন/এবার/কল/আচ্ছা রাখো/রাখি/রাখেন" — the prefix keeps "এটা রাখো" (keep this) out.
    '(?:এখন|এবার|তাহলে|ঠিক\\s*আছে|আচ্ছা|কল)\\s*(?:রাখো|রাখি|রাখেন|রাখুন)',
    // direct hang-up commands the owner actually used, 2026-07-18
    'কে?টে\\s*দা[ওয]',
    'রেখে\\s*দা[ওয]',
    'কল\\s*(?:কেটে|বন্ধ|কাটো|কাট)',
    'আর\\s*কিছু\\s*(?:লাগবে|বলার|দরকার|বলব)\\s*(?:না|নেই)',
    'কথা\\s*শেষ',
    // Banglish
    '\\b(?:bye|goodbye)\\b',
    '\\b(?:khoda|khuda|allah)\\s*hafez\\b',
    '\\b(?:rakhchi|rakhlam|kete\\s*dao|rekhe\\s*dao|hang\\s*up|cut\\s*(?:the\\s*)?call)\\b',
    '\\b(?:ekhon|ebar|accha|thik\\s*ache)\\s*rakho\\b',
    '\\b(?:ok|okay|thik\\s*ache|accha)\\s*(?:rakhi|rakho|bye)\\b',
  ].join('|'),
  'i',
)

/** True when the caller's utterance is a genuine goodbye / end-of-call signal. */
export function endSignalFromCaller(raw) {
  return END_SIGNAL_RE.test(String(raw ?? ''))
}

// A short, content-free "yes" — used ONLY to confirm a hang-up the caller already
// asked for, so it must not fire on a sentence that carries a new question/topic.
// Includes bare hang-up verbs ("রাখো"/"রাখেন") which in the confirm context mean yes,
// even though on their own (mid-conversation) they are not treated as an end-signal.
const AFFIRM_RE =
  /(?:^|\s)(?:হ্যাঁ|হ্যা|জি|জ্বি|জ্বী|হু|হুম|আচ্ছা|ঠিক\s*আছে|রাখো|রাখেন|রাখি|রাখো্|ok|okay|yes|yep|ha|hae|ji|hmm|thik\s*ache|accha|rakho)(?:$|\s|,|।)/i

/**
 * The caller was asked "shall I hang up?" — is THIS reply a yes?
 * A repeat goodbye counts; so does a short bare affirmative (≤3 words, no "?").
 * A longer sentence or a question is treated as "no, keep talking".
 */
export function isHangupConfirmation(raw) {
  const t = String(raw ?? '').trim()
  if (!t) return false
  if (endSignalFromCaller(t)) return true
  if (t.includes('?') || t.includes('？')) return false
  const words = t.split(/\s+/).filter(Boolean)
  return words.length <= 3 && AFFIRM_RE.test(` ${t} `)
}
