/**
 * A job keeps its size — owner, live 2026-07-27.
 *
 * The work class (chat | deep | long_run) sets the turn's round cap AND the
 * head's tool budget. It was derived from the latest message alone, so:
 *
 *   "almatraders.com এর পুরো দুর্বল title আর meta ঠিক করে দাও"  → deep, 60 rounds
 *   [taps] "হ্যাঁ, এখনই শুরু করুন"                              → chat, 8 rounds
 *
 * Same job, two sizes, and the smaller one landed at exactly the moment the work
 * actually started. He watched it stop; from his side the agent simply gave up.
 *
 * So a deep/long-run turn now REMEMBERS the class for the conversation, and a
 * later turn that would classify smaller inherits it. Two bounds keep this
 * honest: it expires (a class must not leak into next week's chat), and it can
 * only ever WIDEN a turn — never shrink one, never grant permission. Rounds are
 * a ceiling, not a spend: a short reply that inherits a big ceiling still costs
 * what a short reply costs.
 */
import { prisma } from '@/lib/prisma'
import type { TurnWorkClass } from '@/agent/config'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/**
 * How long a remembered class survives without being refreshed. Long enough to
 * cover an approval round-trip and a few working turns; short enough that
 * tomorrow's "হাই" is a chat reply again.
 */
export const WORK_CLASS_TTL_MS = 45 * 60 * 1000

const RANK: Record<TurnWorkClass, number> = { chat: 0, deep: 1, long_run: 2 }

export function isTurnWorkClass(v: unknown): v is TurnWorkClass {
  return v === 'chat' || v === 'deep' || v === 'long_run'
}

/** The WIDER of two classes — inheritance may only ever widen. */
export function widerWorkClass(a: TurnWorkClass, b: TurnWorkClass): TurnWorkClass {
  return RANK[a] >= RANK[b] ? a : b
}

export interface RememberedWorkClass {
  workClass: TurnWorkClass
  until: Date
}

/** What this conversation remembers, or null when nothing live is stored. */
export function readRememberedWorkClass(
  row: { workClass?: unknown; workClassUntil?: unknown } | null | undefined,
  now: number = Date.now(),
): RememberedWorkClass | null {
  if (!row || !isTurnWorkClass(row.workClass)) return null
  const until = row.workClassUntil instanceof Date
    ? row.workClassUntil
    : typeof row.workClassUntil === 'string'
      ? new Date(row.workClassUntil)
      : null
  if (!until || !Number.isFinite(until.getTime()) || until.getTime() <= now) return null
  return { workClass: row.workClass, until }
}

/**
 * The class this turn should run at: what the message itself asks for, widened
 * by what the job already established.
 */
export function effectiveWorkClass(
  derived: TurnWorkClass,
  remembered: RememberedWorkClass | null,
): TurnWorkClass {
  if (!remembered) return derived
  return widerWorkClass(derived, remembered.workClass)
}

/**
 * Persist the class for the rest of the job. Only 'deep' and 'long_run' are
 * worth remembering — a chat reply has nothing to carry, and writing it would
 * just churn the row. Fire-and-forget: losing this costs a smaller next turn,
 * never a wrong one.
 */
export async function rememberWorkClass(
  conversationId: string | null | undefined,
  workClass: TurnWorkClass,
  now: number = Date.now(),
): Promise<void> {
  if (!conversationId || workClass === 'chat') return
  try {
    await db.agentConversation.update({
      where: { id: conversationId },
      data: { workClass, workClassUntil: new Date(now + WORK_CLASS_TTL_MS) },
    })
  } catch (err) {
    console.warn('[work-class] remember failed:', err instanceof Error ? err.message : err)
  }
}

/** Read the stored class for a conversation. Fails to null, never throws. */
export async function loadRememberedWorkClass(
  conversationId: string | null | undefined,
  now: number = Date.now(),
): Promise<RememberedWorkClass | null> {
  if (!conversationId) return null
  try {
    const row = await db.agentConversation.findUnique({
      where: { id: conversationId },
      select: { workClass: true, workClassUntil: true },
    })
    return readRememberedWorkClass(row, now)
  } catch (err) {
    console.warn('[work-class] load failed:', err instanceof Error ? err.message : err)
    return null
  }
}
