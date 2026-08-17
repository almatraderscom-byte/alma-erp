/**
 * Unread chats — "the agent wrote while Boss was away".
 *
 * Definition (deliberately narrow, so the badge never cries wolf) — BOTH must hold:
 *   1. Boss is in the chat at all: it contains at least one message of his.
 *   2. Its newest ASSISTANT message is later than the moment he last opened it.
 * His own messages never make a chat unread, and a chat he has open right now is
 * marked read as he opens it.
 *
 * Condition 1 is not decoration. The agent runs scheduled conversations by itself
 * — day_shift, heartbeat, plan_drive — which are assistant-only transcripts, and
 * without it the badge read "4" while not one of his own chats had anything new
 * (owner-reported on build 107). A badge that points at nothing he can find is
 * worse than no badge.
 *
 * Read state lives on the conversation (`lastReadAt`) because this surface has
 * exactly one reader — the owner.
 */
import { prisma } from '@/lib/prisma'

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
    by: ['conversationId', 'role'],
    where: { conversationId: { in: ids }, role: { in: ['assistant', 'user'] } },
    _max: { createdAt: true },
  })

  const lastAgentBy = new Map<string, Date>()
  const hasOwnerMessage = new Set<string>()
  for (const row of rows) {
    if (row.role === 'user') hasOwnerMessage.add(row.conversationId)
    else if (row._max.createdAt) lastAgentBy.set(row.conversationId, row._max.createdAt)
  }

  for (const [conversationId, lastAgentAt] of lastAgentBy) {
    // A chat only counts if BOSS IS IN IT. The scheduled ones the agent runs by
    // itself — day_shift, heartbeat, plan_drive — are all agent messages and no
    // owner message, and counting them made the badge read 4 while none of his
    // own chats had anything new (owner-reported 2026-08-17).
    if (!hasOwnerMessage.has(conversationId)) continue
    const lastReadAt = lastReadById.get(conversationId) ?? null
    if (!lastReadAt || lastAgentAt > lastReadAt) unread.add(conversationId)
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
      -- Boss must actually be IN the chat. The agent's own scheduled runs
      -- (day_shift, heartbeat, plan_drive) are assistant-only transcripts; they
      -- made the badge count chats he was never part of.
      AND EXISTS (
        SELECT 1 FROM "agent_messages" m
        WHERE m."conversationId" = c."id" AND m."role" = 'user'
      )
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

  // RAW on purpose: a Prisma update would also bump `@updatedAt`, and the
  // conversation list orders and paginates by it — so merely READING an old chat
  // would jump it to the top of his sidebar and rewrite its activity date.
  // Reading is not activity.
  const count = await prisma.$executeRaw`
    UPDATE "agent_conversations"
    SET "last_read_at" = ${readAt}
    WHERE "id" = ${id}
      AND ("last_read_at" IS NULL OR "last_read_at" < ${readAt})
  `
  if (count > 0) return true
  // Nothing updated: either the row is gone, or it was already read past this
  // point — which is success, not failure.
  const exists = await prisma.agentConversation.count({ where: { id } })
  return exists > 0
}
