/**
 * A correction outranks everything — owner, 2026-08-02 (audit P0-4, §B.1.4).
 *
 * When Boss corrected the agent mid-task, the correction lived in exactly one
 * place: the transcript. Everything downstream then had to notice it on its
 * own — a different model on the next turn (before P0-1), a compacted history,
 * a specialist that never sees the raw chat. So the correction competed for
 * attention with fifty other lines instead of governing the task, and the same
 * wrong thing happened again.
 *
 * This module makes it durable and puts it FIRST. Two deliberate limits:
 *
 *  - Detection is a narrow, high-precision regex. Treating an ordinary message
 *    as a correction would shout an irrelevant instruction over every later
 *    turn, which is worse than missing one — so the patterns only match the
 *    unambiguous shapes ("na, oita na", "ভুল হয়েছে", "আগেই বলেছি", "বলিনি তো").
 *  - It stores the owner's OWN words, verbatim. A paraphrase is the agent
 *    deciding what he meant, which is the failure this is meant to fix.
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** How many corrections a conversation carries. The newest leads. */
export const MAX_CORRECTIONS = 5

export interface OwnerCorrection {
  text: string
  at: string
}

/**
 * Unambiguous correction shapes in Bangla, Banglish and English. Narrow ON
 * PURPOSE — see the header. A plain "না" answering a yes/no question is NOT a
 * correction, so bare negations are excluded; the patterns all carry the sense
 * of "you did the wrong thing" or "I already told you".
 */
const CORRECTION_RE = new RegExp(
  [
    // "na, oita na" / "না, ওটা না" — a negation POINTING at something done
    // \b does not understand Bangla script, so a Bangla token gets the
    // no-more-Bangla-letters guard this repo already uses elsewhere.
    '(^|\\s)(na|না|nah|no)[,\\s]+((oi|ঐ|ওই|oita|ওটা|eta|এটা|seta|সেটা|that|this)(?![ঀ-ৼa-z])|ta\\s*na|টা\\s*না)',
    '(eta|এটা|oita|ওটা|seta|সেটা)\\s*(na|না|noy|নয়|nah)(?![ঀ-ৼa-z])',
    // wrong / mistake, said of the agent's own work
    '(bhul|vul|ভুল)\\s*(hoyeche|hoise|হয়েছে|হইছে|korle|korecho|করেছ|করছ|korteso|ta|টা)',
    '(ভুল|bhul|vul)\\s*(kaj|জায়গা|jaygay|chat|চ্যাটে|jinis)',
    // "I already told you" / "I did not say that"
    '(age|আগে|agei|আগেই)\\s*(to\\s*)?(bol|বল|বলে|boli)',
    '(ami|আমি)\\s*(to\\s*)?(bolini|বলিনি|boli\\s*ni|বলি\\s*নি)',
    '(bollam|বললাম|bolechi|বলেছি)\\s*(to|তো)\\b',
    // "again the same thing"
    '(abar|আবার)\\s*(oi|ঐ|ওই|same|একই|ekoi|eki)\\b',
    '(same|একই|ekoi)\\s*(bhul|ভুল|jinis|জিনিস|kaj|কাজ)',
    // explicit "not this way / do it differently"
    '(evabe|এভাবে|oivabe|ওভাবে)\\s*(na|না|noy|নয়)',
    '(ami|আমি)\\s*(eta|এটা|oita|ওটা)\\s*(chai\\s*ni|চাইনি|chaini)',
  ].join('|'),
  'i',
)

export function isOwnerCorrection(text: string | null | undefined): boolean {
  const t = String(text ?? '').trim()
  if (!t || t.length > 600) return false
  return CORRECTION_RE.test(t)
}

/** Parse whatever is stored on the row into a clean, newest-first list. */
export function readCorrections(raw: unknown): OwnerCorrection[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((c): c is OwnerCorrection =>
      Boolean(c) && typeof (c as OwnerCorrection).text === 'string' && typeof (c as OwnerCorrection).at === 'string')
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, MAX_CORRECTIONS)
}

/**
 * Record the owner's message as a correction when it unmistakably is one.
 * Returns true when something was stored. Fail-open: a lost correction costs
 * the old behaviour, never a broken turn.
 */
export async function recordCorrectionIfAny(
  conversationId: string | null | undefined,
  text: string | null | undefined,
  now: Date = new Date(),
): Promise<boolean> {
  if (!conversationId || !isOwnerCorrection(text)) return false
  try {
    const row = await db.agentConversation.findUnique({
      where: { id: conversationId },
      select: { corrections: true },
    })
    const existing = readCorrections(row?.corrections)
    // His own words, verbatim — a paraphrase would be the agent deciding what
    // he meant, which is the failure this exists to fix.
    const entry: OwnerCorrection = { text: String(text).trim().slice(0, 400), at: now.toISOString() }
    if (existing[0] && existing[0].text === entry.text) return false
    await db.agentConversation.update({
      where: { id: conversationId },
      data: { corrections: [entry, ...existing].slice(0, MAX_CORRECTIONS) },
    })
    return true
  } catch (err) {
    console.warn('[owner-corrections] record failed:', err instanceof Error ? err.message : err)
    return false
  }
}

/** Load this conversation's corrections, newest first. Fails to empty. */
export async function loadCorrections(conversationId: string | null | undefined): Promise<OwnerCorrection[]> {
  if (!conversationId) return []
  try {
    const row = await db.agentConversation.findUnique({
      where: { id: conversationId },
      select: { corrections: true },
    })
    return readCorrections(row?.corrections)
  } catch {
    return []
  }
}

/**
 * The block that rides at the TOP of the turn context. Written so the newest
 * correction cannot be read as one item in a list — it is the instruction that
 * outranks the rest of the context, including anything the agent itself said
 * earlier in the conversation.
 */
export function buildCorrectionNote(corrections: OwnerCorrection[]): string {
  if (corrections.length === 0) return ''
  const [latest, ...older] = corrections
  const lines = [
    '⚠️ [BOSS-এর সংশোধন — এটাই সবার উপরে, আগের যেকোনো নির্দেশ/তোমার নিজের পরিকল্পনার চেয়ে বেশি জোরালো]',
    `সর্বশেষ সংশোধন (${latest.at.slice(0, 16).replace('T', ' ')}): "${latest.text}"`,
    'পরের কাজটা করার আগে এই সংশোধনটা মেনে নিয়েছ কিনা নিজে যাচাই করো। একই ভুল দ্বিতীয়বার করা যাবে না — ' +
    'আগে যেভাবে করেছিলে ঠিক সেভাবে আবার কোরো না, আর নিশ্চিত না হলে এক লাইনে জিজ্ঞেস করো।',
  ]
  if (older.length > 0) {
    lines.push(`আগের সংশোধনগুলোও এখনো প্রযোজ্য: ${older.map((c) => `"${c.text}"`).join(' · ')}`)
  }
  return lines.join('\n')
}
