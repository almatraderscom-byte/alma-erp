/**
 * Staff task nudge + owner escalation helpers (Phase 3 — zero LLM).
 */
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'

export const MAX_STAFF_NUDGES = 2
export const NUDGE1_MS = 30 * 60 * 1000
export const NUDGE2_MS = 60 * 60 * 1000
export const ESCALATE_MS = 2 * 60 * 60 * 1000

export function shortTitle(title) {
  const s = String(title ?? '').trim()
  return s.length > 48 ? `${s.slice(0, 45)}…` : s
}

export function getTaskNudgeCount(proofData) {
  const pd = proofData ?? {}
  return Number(pd.nudgeCount ?? pd.reminderStage ?? (pd.reminderSentAt ? 1 : 0)) || 0
}

export function staffTaskNudgeMessage(title) {
  return `⏰ ভাই, ${shortTitle(title)} টা বাকি — শেষ হলে ✅ Done চাপুন।`
}

export function staffProofNudgeMessage(title) {
  return `📸 ভাই, ${shortTitle(title)} এর screenshot/প্রমাণ পাঠান — verify করে দিচ্ছি।`
}

/** One short owner line: what's stuck + why + recommendation. */
export function formatOwnerEscalation({ staffName, title, reason, recommendation }) {
  const name = staffName ?? 'স্টাফ'
  const rec = recommendation ?? 'আজ রাতে বা কাল সকালে follow-up করুন।'
  return `⚠️ ${name}: "${shortTitle(title)}" — ${reason}. ${rec}`
}

export async function sendOwnerEscalation(telegram, ownerChatId, line) {
  if (!ownerChatId || !telegram || !line) return false
  try {
    await sendMarkdownSafe(telegram, ownerChatId, line)
    return true
  } catch (err) {
    console.warn('[task-nudge] owner escalation send failed:', err.message)
    return false
  }
}
