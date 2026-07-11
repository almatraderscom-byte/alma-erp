/**
 * Salah jamaat/alone capture.
 *
 * After the owner confirms he prayed a waqt, the conscience-nudge (core.ts) asks
 * softly: "জামাতে পড়লেন নাকি একা, Boss?". The owner's next short reply ("eka poreci",
 * "jamaate poreci") is a CONVERSATIONAL answer — never a work task. This module sets
 * a one-shot pending marker when the question is asked, captures the answer, saves it
 * to memory, and returns a contextBlock that EXPLICITLY forbids the head from turning
 * the answer into a todo / reminder / task.
 *
 * Permanent fix for the bug where "eka poreci" became "কালকের জন্য 1টি কাজ".
 *
 * Mirrors the salah-muhasaba pending-marker + reply-capture pattern. No schema change:
 * the answer is stored in agent memory, the marker in agent_kv_settings.
 */
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { createOrUpdateAgentMemory } from '@/agent/lib/agent-memory'

const BUSINESS_ID = 'ALMA_LIFESTYLE'
const PENDING_KEY = 'salah_jamaat_pending'
// One-shot guard: a marker older than this is stale and must not catch an unrelated
// later "eka" (e.g. owner mentioning he's alone in the shop hours later).
const MAX_AGE_MS = 30 * 60 * 1000 // 30 minutes

const WAQT_BN: Record<string, string> = {
  fajr: 'ফজর',
  dhuhr: 'যোহর',
  asr: 'আসর',
  maghrib: 'মাগরিব',
  isha: 'ইশা',
}

type PendingPayload = { waqt: string; date: string; askedAt: string }

/** Called right after the conscience-nudge question is queued. Idempotent. */
export async function markJamaatPending(waqt: string, dateYmd: string, now = new Date()): Promise<void> {
  const payload: PendingPayload = { waqt, date: dateYmd, askedAt: now.toISOString() }
  try {
    await prisma.agentKvSetting.upsert({
      where: { key: PENDING_KEY },
      create: { key: PENDING_KEY, value: JSON.stringify(payload) },
      update: { value: JSON.stringify(payload) },
    })
  } catch (err) {
    console.warn('[jamaat] markPending failed:', err instanceof Error ? err.message : err)
  }
}

async function readPending(now = new Date()): Promise<PendingPayload | null> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: PENDING_KEY }, select: { value: true } })
  if (!row?.value) return null
  let p: PendingPayload
  try {
    p = JSON.parse(row.value) as PendingPayload
  } catch {
    return null
  }
  const askedMs = Date.parse(p.askedAt)
  if (!Number.isFinite(askedMs) || now.getTime() - askedMs > MAX_AGE_MS) return null
  return p
}

async function clearPending(): Promise<void> {
  await prisma.agentKvSetting.deleteMany({ where: { key: PENDING_KEY } })
}

export type JamaatAnswer = 'jamaat' | 'alone' | null

/** Parse a short reply into jamaat / alone / null (no clear answer). */
export function parseJamaatAnswer(text: string): JamaatAnswer {
  const t = text.toLowerCase()
  // Jamaat keywords (congregation / masjid). Check first — "masjide jamaate" wins.
  if (/(জামাত|জামায়াত|মসজিদ|congregation|jama[a']?t|jamat|masjid|moshjid|mosque)/i.test(t)) return 'jamaat'
  // Alone keywords (by self / at home).
  if (/(একা|একাই|নিজে|ঘরে|বাসায়|alone|eka\b|ekai|nij[e]?|ghore|bashay|by\s*my\s*self)/i.test(t)) return 'alone'
  return null
}

export type JamaatReplyResult = { contextBlock?: string }

/**
 * Capture the owner's answer to the jamaat/alone question (first reply while the
 * one-shot marker is live). Saves to memory and returns a contextBlock instructing
 * the head to reply warmly and — CRITICALLY — to NOT create any todo/reminder/task.
 * Returns null if no marker is pending or the reply isn't a recognizable answer.
 */
export async function processJamaatReply(
  text: string,
  _conversationId?: string,
  now = new Date(),
): Promise<JamaatReplyResult | null> {
  const trimmed = text.trim()
  if (!trimmed) return null

  const pending = await readPending(now)
  if (!pending) return null

  const answer = parseJamaatAnswer(trimmed)
  // One-shot: whatever happens, this question is now consumed so a later stray
  // message never re-triggers. If unparseable, just clear and let the head handle.
  await clearPending()
  if (!answer) return null

  const waqtBn = WAQT_BN[pending.waqt] ?? pending.waqt
  const verdict = answer === 'jamaat' ? 'জামাতে' : 'একা'

  try {
    await createOrUpdateAgentMemory({
      scope: 'business',
      key: `salah_jamaat:${pending.date}:${pending.waqt}`,
      content: `${pending.date} তারিখে ${waqtBn} নামাজ Boss ${verdict} পড়েছেন।`,
      metadata: { type: 'salah_jamaat', date: pending.date, waqt: pending.waqt, jamaat: answer === 'jamaat', businessId: BUSINESS_ID },
      importance: 1,
    })
  } catch (err) {
    console.warn('[jamaat] memory save failed:', err instanceof Error ? err.message : err)
  }

  const guidance =
    answer === 'jamaat'
      ? `Boss prayed ${waqtBn} in JAMAAT. Reply with genuine warmth: a short Alhamdulillah / appreciation that he caught the jamaat, and a tiny du'a. 1-2 lines.`
      : `Boss prayed ${waqtBn} ALONE (not jamaat). Reply with gentle, NO-BLAME encouragement: acknowledge it warmly, softly hope he can catch the next waqt in jamaat, never scold. 1-2 lines.`

  return {
    contextBlock:
      `[SALAH JAMAAT — ANSWER]\n` +
      `Boss just answered your gentle jamaat/alone question about ${waqtBn} (${pending.date}). ` +
      `This is a CONVERSATIONAL answer, NOT a work task. It is ALREADY saved to memory — do NOT call save_memory for it. ` +
      `CRITICAL: do NOT create, schedule, or carry over any todo / reminder / task from this answer — ` +
      `do NOT call manage_work_todos, set_reminder, add_owner_todo, or any task/reminder tool. ` +
      `Just reply conversationally in warm Bangla as Boss. ${guidance}`,
  }
}

/**
 * Deterministic, NO-LLM capture for the two quick-reply buttons (জামাতে / একা)
 * shown under the conscience-nudge question. Tapping a button saves the answer the
 * same way `processJamaatReply` would — but WITHOUT a head turn, since a free-typed
 * reply sometimes isn't recognised by the model. Saves to memory, clears the
 * one-shot pending marker, and returns a warm canned Bangla reply the caller
 * persists as the agent's answer. Works even if the 30-min marker expired (falls
 * back to today / unknown waqt) so a late tap is never lost.
 */
export async function recordJamaatChoiceDirect(
  answer: 'jamaat' | 'alone',
  now = new Date(),
  override?: { waqt?: string | null; date?: string | null },
): Promise<{ reply: string; waqt: string | null }> {
  // The Telegram-bot flow knows the exact waqt + date (it just recorded the
  // prayer) and passes them in; the in-app flow relies on the pending marker.
  const pending = await readPending(now)
  const dateYmd = override?.date ?? pending?.date ?? todayYmdDhaka()
  const waqt = override?.waqt ?? pending?.waqt ?? null
  const waqtBn = waqt ? (WAQT_BN[waqt] ?? waqt) : 'নামাজ'
  const verdict = answer === 'jamaat' ? 'জামাতে' : 'একা'

  try {
    await createOrUpdateAgentMemory({
      scope: 'business',
      key: `salah_jamaat:${dateYmd}:${waqt ?? 'unknown'}`,
      content: `${dateYmd} তারিখে ${waqtBn} নামাজ Boss ${verdict} পড়েছেন।`,
      metadata: { type: 'salah_jamaat', date: dateYmd, waqt: waqt ?? 'unknown', jamaat: answer === 'jamaat', businessId: BUSINESS_ID },
      importance: 1,
    })
  } catch (err) {
    console.warn('[jamaat] direct memory save failed:', err instanceof Error ? err.message : err)
  }
  await clearPending().catch(() => {})

  const reply =
    answer === 'jamaat'
      ? `আলহামদুলিল্লাহ, Boss! ${waqtBn} জামাতে পড়েছেন — আল্লাহ কবুল করুন। 🤲`
      : `ঠিক আছে, Boss। আল্লাহ ${waqtBn} কবুল করুন। পরের ওয়াক্তটা ইনশাআল্লাহ জামাতে পড়ার চেষ্টা করবেন — কোনো চাপ নেই। 🤲`

  return { reply, waqt }
}
