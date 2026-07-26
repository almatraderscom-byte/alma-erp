/**
 * What cards are actually in front of Boss right now — read, not remembered.
 *
 * Owner incident 2026-07-26: the head kept answering "কার্ড অনুমোদনের অপেক্ষায় আছি"
 * for work that was already applied, and on other turns for a card that was never
 * created at all. The approval-continuation path was taught the facts (commit
 * 44b391da) — but that is one path. On an ORDINARY turn the head still had no
 * idea what existed, so it fell back on its own earlier sentence, which is
 * exactly the failure mode: a claim survives until something measurable
 * contradicts it.
 *
 * So every turn now carries the measurement. Two halves, deliberately:
 *   - a short note appended AFTER the cached prefix (end of messages, the
 *     self-correct pattern) so the prompt cache is untouched — Boss watches cost
 *   - a verifier that catches "waiting for approval" when nothing is pending
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export interface PendingCard {
  id: string
  type: string
  summary: string
}

/** Cards genuinely awaiting Boss's decision in this conversation. */
export async function readPendingCards(conversationId: string | null | undefined): Promise<PendingCard[]> {
  if (!conversationId) return []
  try {
    const rows = await db.agentPendingAction.findMany({
      where: { conversationId, status: 'pending' },
      select: { id: true, type: true, summary: true },
      orderBy: { createdAt: 'asc' },
      take: 10,
    })
    return (rows ?? []).map((r: { id: string; type: string | null; summary: string | null }) => ({
      id: r.id,
      type: r.type ?? 'unknown',
      summary: (r.summary ?? '').split('\n')[0].slice(0, 80),
    }))
  } catch (err) {
    // Fail silent: a missing note costs a sentence, a thrown note costs the turn.
    console.warn('[card-state] read failed:', err instanceof Error ? err.message : err)
    return []
  }
}

/**
 * The note the head reads before it speaks. Always states the count — "none" is
 * the fact that was missing, and the one it used to invent.
 */
export function buildCardStateNote(cards: PendingCard[]): string {
  if (cards.length === 0) {
    return (
      '[কার্ডের অবস্থা — সার্ভার থেকে পড়া, তোমার স্মৃতি নয়] '
      + 'এই চ্যাটে এই মুহূর্তে Boss-এর সিদ্ধান্তের অপেক্ষায় কোনো approval card নেই। '
      + 'তাই "অনুমোদনের অপেক্ষায় আছি" বা "কার্ড approve করুন" বোলো না — '
      + 'কাজ বাকি থাকলে নিজে এগোও, শেষ হয়ে থাকলে ফলটা বলো।'
    )
  }
  // One line per card — a card summary is multi-line prose, and a stray newline
  // here would read as a second card.
  const lines = cards.map((c) => `- ${c.type}: ${c.summary.split('\n')[0].slice(0, 80) || '(সারাংশ নেই)'}`)
  return [
    '[কার্ডের অবস্থা — সার্ভার থেকে পড়া, তোমার স্মৃতি নয়] '
      + `এই চ্যাটে ${cards.length}টি approval card এখনো Boss-এর সিদ্ধান্তের অপেক্ষায়:`,
    ...lines,
    'এর বাইরে অন্য কোনো কার্ড অপেক্ষায় নেই।',
  ].join('\n')
}
