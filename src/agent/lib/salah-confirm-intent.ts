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
    /পড়েছি|পড়লাম|পড়েছেন(?! কি)|পড়ে\s*ছি|পড়ে\s*ফেল|পড়ে\s*নিয়েছি/i.test(text)
    || /আদায়\s*কর|namaz\s*por|prayed/i.test(text)
    || /আলহামদুলিল্লাহ.*(পড়|নামাজ)/i.test(text)
    || /(ফজর|যোহর|জোহর|আসর|মাগরিব|ইশা).*(পড়|শেষ|হয়ে|করে)/i.test(text)
    || /(fozr|fajr|dhuhr|asr|maghrib|isha).*(por|done|kore|krsi)/i.test(text)
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

/** Strip "(গতকাল)" suffix from accountability waqt labels */
export function parseWaqtLabel(label: string): { waqt: string; isYesterday: boolean } {
  const isYesterday = /গতকাল/.test(label)
  const waqt = label.replace(/\s*\(গতকাল\)\s*/g, '').trim()
  return { waqt, isYesterday }
}
