/**
 * Detect when the owner confirms they prayed a waqt (Bangla / Banglish).
 */
import type { Waqt } from '@/agent/lib/salah-context'

const WAQT_PATTERNS: Record<Waqt, RegExp[]> = {
  fajr: [/ফজর|ফোজর|fajr|fozr|fojar/i, /ভোর\s*(নামাজ|ওয়াক্ত)/i],
  dhuhr: [/যোহর|জোহর|জুহর|dhuhr|zuhr|johr/i],
  asr: [/আসর|asr/i],
  maghrib: [/মাগরিব|maghrib/i],
  isha: [/ইশা|esha|isha/i],
}

/** Owner is asking — not confirming */
function isSalahQuestion(text: string): boolean {
  return (
    /পড়েছেন\s*কি|পড়েছো\s*কি|পড়লেন\s*কি|porachen\s*ki|porcho\s*ki/i.test(text)
    || /\?\s*$/.test(text.trim()) && /পড়|namaz|নামাজ|ওয়াক্ত/i.test(text)
  )
}

/** Owner confirms prayer was done */
function hasPrayedSignal(text: string): boolean {
  return (
    /পড়েছি|পড়লাম|পড়েছেন(?! কি)|পড়ে\s*ছি|পড়ে\s*ফেল|পড়ে\s*গেছি|পড়ে\s*নিয়েছি/i.test(text)
    || /porlam|porchi|porechi|korechi|korsi|korlam/i.test(text)
    || /নামাজ\s*করেছি|namaz\s*kore|namaz\s*kor|prayed/i.test(text)
    || /আদায়\s*কর|namaz\s*por/i.test(text)
    || /আলহামদুলিল্লাহ.*(পড়|নামাজ|কর)/i.test(text)
    || /(ফজর|যোহর|জোহর|আসর|মাগরিব|ইশা).*(পড়|শেষ|হয়ে|করে|করেছি|গেছে|গেল)/i.test(text)
    || /(fozr|fajr|dhuhr|asr|maghrib|isha).*(por|done|kore|krsi|korechi|geche)/i.test(text)
  )
}

export type SalahConfirmation = {
  waqt?: Waqt
  dateHint?: 'today' | 'yesterday'
}

export function detectSalahConfirmation(text: string): SalahConfirmation | null {
  const t = text.trim()
  if (!t || t.length < 3) return null
  if (isSalahQuestion(t)) return null
  if (!hasPrayedSignal(t)) return null

  let dateHint: 'today' | 'yesterday' | undefined
  if (/গতকাল|yesterday|kal\s*ke|কাল\s*রাত/i.test(t)) dateHint = 'yesterday'

  for (const waqt of Object.keys(WAQT_PATTERNS) as Waqt[]) {
    if (WAQT_PATTERNS[waqt].some((p) => p.test(t))) {
      return { waqt, dateHint }
    }
  }

  return { dateHint }
}

/**
 * Owner declares a waqt as qaza (made-up / overdue) or missed.
 * Conservative on the qaza term so it never collides with "kaj"/"কাজ" (= work):
 * Banglish qaza must end in -a (qaza/kaza/kaja) with a word boundary, Bangla uses
 * কাযা/কাজা (both distinct from কাজ). Missed = পড়িনি / মিস হয়েছে / পড়তে পারিনি etc.
 */
export type SalahQazaIntent = {
  waqt?: Waqt
  kind: 'qaza' | 'missed'
  dateHint?: 'today' | 'yesterday'
}

function hasQazaSignal(text: string): boolean {
  return (
    /কাযা|কাজা/.test(text)
    || /\b(qaza|qa?za|kaza|kaja)\b/i.test(text)
  )
}

function hasMissedSignal(text: string): boolean {
  return (
    /পড়িনি|পরিনি|পড়া\s*হয়নি|পড়তে\s*পারিনি|মিস\s*হয়েছে|মিস\s*হয়ে|মিস\s*করেছি|বাদ\s*(পড়ে|গেছে|গেল)/i.test(text)
    || /\b(porini|pori\s*nai|pora\s*hoyni|porte\s*parini|miss\s*hoye|miss\s*korechi|missed|baad\s*por)\b/i.test(text)
  )
}

export function detectSalahQaza(text: string): SalahQazaIntent | null {
  const t = text.trim()
  if (!t || t.length < 3) return null
  if (isSalahQuestion(t)) return null

  const isQaza = hasQazaSignal(t)
  const isMissed = hasMissedSignal(t)
  if (!isQaza && !isMissed) return null

  // qaza wins if both appear ("miss hoye geche, kaja kore nibo" → treat as qaza)
  const kind: 'qaza' | 'missed' = isQaza ? 'qaza' : 'missed'

  let dateHint: 'today' | 'yesterday' | undefined
  if (/গতকাল|yesterday|kal\s*ke|কাল\s*রাত/i.test(t)) dateHint = 'yesterday'

  for (const waqt of Object.keys(WAQT_PATTERNS) as Waqt[]) {
    if (WAQT_PATTERNS[waqt].some((p) => p.test(t))) {
      return { waqt, kind, dateHint }
    }
  }

  return { kind, dateHint }
}

/**
 * STRICT gate for the spoken live-call path (/api/assistant/salah/confirm-spoken).
 * detectSalahQaza accepts a bare topic mention ("কাযা") and hasPrayedSignal
 * accepts the stem "আদায় কর" — fine for chat (long-standing behavior, the
 * owner types deliberately) but too loose for every finalized call utterance
 * (Codex P1, PR #762): "কাযা নামাজের নিয়ম বলো" or "নামাজ আদায় করার জন্য
 * reminder তৈরি করো" must never auto-mark. Require a real declaration and
 * reject request/question/future-intent wording outright.
 */
export function isSpokenSalahDeclaration(text: string): boolean {
  const t = text.trim()
  if (!t || t.length < 3) return false
  // Every finalized call transcript reaches this gate, so an unrelated
  // business sentence that merely names a waqt ("ইশার কাজ শেষ করেছি") must
  // not be trusted to the broad `waqt.*শেষ/করেছি` detector patterns (Codex
  // P1 round 4). Require an unambiguous prayer noun or a পড়/pray verb —
  // and "পড়াশোনা" (studying) is reading, not praying.
  const prayerContext =
    /নামাজ|নামায|সালাত|সালাহ|namaz|namaj|salah|salat|কাযা|কাজা|qaza|kaza|আদায়|pray/i.test(t)
    || (/পড়/.test(t) && !/পড়াশোনা|পড়াশুনা|বই\s*পড়/.test(t))
    || /porech|porl|porin|pora\s*hoyni/i.test(t)
    // A waqt name IMMEDIATELY carrying a miss signal ("ফজর মিস হয়ে গেছে") is
    // a prayer declaration; a waqt used as a time-of-day for something else
    // ("ইশার মিটিং মিস করেছি") is not.
    || /(?:ফজর|যোহর|জোহর|জুহর|আসর|মাগরিব|ইশা|fajr|fozr|dhuhr|zuhr|johr|asr|maghrib|isha|esha)(?:র|ের)?\s*(?:মিস|miss)/i.test(t)
  if (!prayerContext) return false
  // Requests, questions, instructions and future intent are not declarations.
  if (
    /নিয়ম|কিভাবে|কীভাবে|কখন|কয়টায়|reminder|রিমাইন্ড|মনে করিয়ে|তৈরি|বানাও|সেট কর|বলো|বলে দাও|শোনাও|জানাও|শেখাও/i.test(t)
    || /পড়ব|পড়বো|পড়ে নিব|পড়ে নেব|পড়ে ফেলব|পড়ে ফেলবো|পড়তে হবে|হয়ে যাবে|porbo|pore nibo|pore nebo|pore felbo|porte hobe|hoye jabe|will pray/i.test(t)
    // English negation: "I haven't/never/had not prayed Isha" contains
    // "prayed" and would otherwise mark the OPPOSITE of what the owner said
    // (Codex P1 rounds 3–5).
    || /have?n'?t|hasn'?t|didn'?t|did not|have not|had not|couldn'?t|could not|never|not sure/i.test(t)
    // Bengali doubt/negative clause around a completed verb: "পড়েছি বলে মনে
    // হয় না" (Codex P1 round 5).
    || /মনে হয় না|মনে নেই|bole mone hoy na|mone nei/i.test(t)
    // English interrogative without punctuation, ANY subject: "Have I prayed
    // Isha", "Has Rahim prayed Isha", "Did you pray fajr" (Codex P1 rounds
    // 4–5). A declaration never LEADS with an auxiliary/wh-word.
    || /^(?:have|has|had|did|do|does|am|is|are|was|were|when|what|why|who|whom)\b/i.test(t)
    || /\b(?:have|has|did|do|does|am|was|when|what)\s+i\b/i.test(t)
    // Unpunctuated first-person status question: "পড়েছি কি(না)" — voice
    // transcripts carry no guaranteed "?". The lookahead keeps "পড়েছি
    // কিছুক্ষণ আগে" (a real declaration) out of the net.
    || /পড়েছি\s*কি(?:না|(?=\s|$|\?))/.test(t)
    || /porechi\s*ki(?:na|(?=\s|$|\?))/i.test(t)
  ) return false
  // Owner attribution (Codex P1 round 6): a declaration about someone ELSE
  // ("Rahim prayed Isha", "রহিম ইশার নামাজ পড়েছে") must not mark the owner's
  // record. English pray-sentences need a first-person subject; Bangla
  // third-person completed verbs (word-final পড়েছে / পড়েছেন / করেছে-after-
  // আদায়) are about someone else — the owner's own forms are পড়েছি/পড়লাম.
  if (/pray/i.test(t) && !/\b(?:i|i've|ami)\b/i.test(t) && !/আমি/.test(t)) return false
  if (/পড়েছে(?!\S)|পড়েছেন|পড়ে ফেলেছে|আদায় করেছে(?!\S)/.test(t)) return false
  return Boolean(detectSalahConfirmation(t) || detectSalahQaza(t))
}

/** Strip "(গতকাল)" suffix from accountability waqt labels */
export function parseWaqtLabel(label: string): { waqt: string; isYesterday: boolean } {
  const isYesterday = /গতকাল/.test(label)
  const waqt = label.replace(/\s*\(গতকাল\)\s*/g, '').trim()
  return { waqt, isYesterday }
}
