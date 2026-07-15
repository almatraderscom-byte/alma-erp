import { prisma } from '@/lib/prisma'
import { isHeartbeatWakeText } from '@/agent/lib/heartbeat/wake-marker'
import { messageContentToText } from '@/agent/lib/message-recall'

const MAX_VISIBLE_TURN_AGE_MS = 30 * 60 * 1000
const MAX_ACTIVE_TURNS = 20

export type ActiveBackgroundTurn = {
  id: string
  conversationId: string
  conversationTitle: string | null
  kind: 'active-chat' | 'self-wake'
  input: string
  startedAt: string
  updatedAt: string | null
}

export function activeTurnKind(
  input: string,
  conversationSource: string | null | undefined,
): ActiveBackgroundTurn['kind'] {
  return conversationSource === 'heartbeat' || isHeartbeatWakeText(input)
    ? 'self-wake'
    : 'active-chat'
}

/**
 * Owner-global running turns for the native Background Tasks surface.
 *
 * This is intentionally one bounded query per table instead of polling every
 * conversation's turn-status endpoint. It keeps chat-session switching cheap and
 * ensures the native screen has one server-authoritative running count.
 */
export async function listActiveBackgroundTurns(
  now: Date = new Date(),
): Promise<ActiveBackgroundTurn[]> {
  const cutoff = new Date(now.getTime() - MAX_VISIBLE_TURN_AGE_MS)
  const turns = await prisma.agentTurn.findMany({
    where: { status: 'running', startedAt: { gte: cutoff } },
    orderBy: { startedAt: 'asc' },
    take: MAX_ACTIVE_TURNS,
    select: {
      id: true,
      conversationId: true,
      userMessageId: true,
      startedAt: true,
      updatedAt: true,
    },
  })
  if (turns.length === 0) return []

  const conversationIds = [...new Set(turns.map((turn) => turn.conversationId))]
  const userMessageIds = turns
    .map((turn) => turn.userMessageId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)

  const [conversations, messages] = await Promise.all([
    prisma.agentConversation.findMany({
      where: { id: { in: conversationIds } },
      select: { id: true, title: true, source: true },
    }),
    userMessageIds.length
      ? prisma.agentMessage.findMany({
          where: { id: { in: userMessageIds } },
          select: { id: true, content: true },
        })
      : Promise.resolve([]),
  ])

  const conversationById = new Map(conversations.map((row) => [row.id, row]))
  const inputByMessageId = new Map(
    messages.map((row) => [row.id, messageContentToText(row.content)]),
  )

  return turns.map((turn) => {
    const conversation = conversationById.get(turn.conversationId)
    const input = turn.userMessageId ? (inputByMessageId.get(turn.userMessageId) ?? '') : ''
    return {
      id: turn.id,
      conversationId: turn.conversationId,
      conversationTitle: conversation?.title ?? null,
      kind: activeTurnKind(input, conversation?.source),
      input,
      startedAt: turn.startedAt.toISOString(),
      updatedAt: turn.updatedAt?.toISOString() ?? null,
    }
  })
}
