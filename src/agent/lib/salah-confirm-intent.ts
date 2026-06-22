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

/** Strip "(গতকাল)" suffix from accountability waqt labels */
export function parseWaqtLabel(label: string): { waqt: string; isYesterday: boolean } {
  const isYesterday = /গতকাল/.test(label)
  const waqt = label.replace(/\s*\(গতকাল\)\s*/g, '').trim()
  return { waqt, isYesterday }
}
