/**
 * Unread chats — "the agent wrote while Boss was away".
 *
 * Definition (deliberately narrow, so the badge never cries wolf):
 *   a conversation is UNREAD when its newest ASSISTANT message is later than the
 *   moment Boss last opened that conversation.
 * His own messages never make a chat unread, and a chat he has open right now is
 * marked read as he opens it.
 *
 * Read state lives on the conversation (`lastReadAt`) because this surface has
 * exactly one reader — the owner.
 */
import { prisma } from '@/lib/prisma'

/** Roles that count as "the agent said something". */
const AGENT_ROLES = ['assistant'] as const

/**
 * Which of these conversation ids are unread. One grouped query, no per-row
 * fan-out — the sidebar asks about up to 50 ids at a time.
 */
export async function unreadConversationIds(
  ids: string[],
  lastReadById: Map<string, Date | null>,
): Promise<Set<string>> {
  const unread = new Set<string>()
  if (!ids.length) return unread

  const rows = await prisma.agentMessage.groupBy({
    by: ['conversationId'],
    where: { conversationId: { in: ids }, role: { in: [...AGENT_ROLES] } },
    _max: { createdAt: true },
  })

  for (const row of rows) {
    const lastAgentAt = row._max.createdAt
    if (!lastAgentAt) continue
    const lastReadAt = lastReadById.get(row.conversationId) ?? null
    if (!lastReadAt || lastAgentAt > lastReadAt) unread.add(row.conversationId)
  }
  return unread
}

/**
 * How many ACTIVE chats are unread, across the whole table — not just the page
 * the sidebar happens to be showing. This is the number on the badge.
 */
export async function countUnreadConversations(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "agent_conversations" c
    WHERE c."archived" = false
      AND EXISTS (
        SELECT 1 FROM "agent_messages" m
        WHERE m."conversationId" = c."id"
          AND m."role" = 'assistant'
          AND (c."last_read_at" IS NULL OR m."createdAt" > c."last_read_at")
      )
  `
  return Number(rows[0]?.count ?? 0)
}

/**
 * Boss opened this chat — everything he was SHOWN is now read.
 *
 * `upTo` is the timestamp of the newest message the client actually rendered.
 * Stamping the server's clock instead would swallow a reply that a background
 * job wrote between the history fetch and this call: it would be marked read
 * without ever having been on screen. Clamped to now (a client clock cannot
 * mark the future read) and never moved backwards.
 */
export async function markConversationRead(id: string, upTo?: Date | null): Promise<boolean> {
  const now = new Date()
  // No rendered timestamp means the caller displayed nothing it can vouch for
  // (empty history). Advancing to the server clock there would silently swallow a
  // background reply written between that fetch and this call, so leave the
  // watermark alone — there is nothing to mark read.
  if (!upTo || Number.isNaN(upTo.getTime())) {
    return (await prisma.agentConversation.count({ where: { id } })) > 0
  }
  const readAt = upTo < now ? upTo : now

  const res = await prisma.agentConversation.updateMany({
    where: { id, OR: [{ lastReadAt: null }, { lastReadAt: { lt: readAt } }] },
    data: { lastReadAt: readAt },
  })
  if (res.count > 0) return true
  // Nothing updated: either the row is gone, or it was already read past this
  // point — which is success, not failure.
  const exists = await prisma.agentConversation.count({ where: { id } })
  return exists > 0
}
