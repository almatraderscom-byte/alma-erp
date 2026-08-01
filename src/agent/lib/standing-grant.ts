/**
 * The standing grant, read from the row rather than from memory.
 *
 * A turn can run for a minute or more. In that time Boss can revoke the grant
 * from another request — the app's settings, a second chat, the revoke tool in a
 * different turn — and the turn-local snapshot would still be authorising work
 * he has already cancelled (review bot, #667). Every bypass therefore confirms
 * against the database immediately before it lets a call through.
 *
 * Cheap by construction: this only runs when a bypass is about to happen, i.e.
 * for a call whose family the in-memory grant already names.
 */
import { prisma } from '@/lib/prisma'
import {
  isFamilyGrantLive,
  parseElevationGrant,
  type ElevationGrant,
} from '@/agent/lib/permission-mode'

/** The conversation's grant as the database has it right now, or null. */
export async function readLiveGrant(
  conversationId: string | null | undefined,
): Promise<ElevationGrant | null> {
  if (!conversationId) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conv = await (prisma as any).agentConversation.findUnique({
      where: { id: conversationId },
      select: { elevationGrant: true },
    })
    return parseElevationGrant(conv?.elevationGrant)
  } catch {
    // A read failure must never widen a permission — no grant is the safe answer.
    return null
  }
}

/**
 * Does a LIVE grant — confirmed against the row — cover this family right now?
 * Fails closed on anything unexpected.
 */
export async function confirmGrantStillCovers(
  conversationId: string | null | undefined,
  family: string,
): Promise<boolean> {
  const grant = await readLiveGrant(conversationId)
  return isFamilyGrantLive(grant, family, Date.now())
}
