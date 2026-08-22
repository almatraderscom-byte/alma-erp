import { prisma } from '@/lib/prisma'
import { messageContentToText } from '@/agent/lib/message-recall'
import { isDirectYouTubeBrowserTask } from '@/agent/lib/live-browser/intent'
import { isDirectBrowserContinuationText } from '@/agent/lib/live-browser/turn-lane'

/**
 * The owner input that belongs to one durable AgentTurn. Conversation history is
 * deliberately not a fallback: two tabs may append different owner messages
 * while both turns are still running, so "latest message" is not turn identity.
 */
export type TurnOwnerInputBinding =
  | {
      state: 'bound'
      messageId: string
      createdAt: Date
      text: string
      askCardId: string | null
    }
  | { state: 'absent' }
  | { state: 'unavailable' }

export type TurnScopedOwnerInput =
  | {
      state: 'exact'
      authoritativeText: string
      askCardId: string | null
    }
  | {
      state: 'none'
      authoritativeText: string
    }
  | {
      state: 'unavailable'
      authoritativeText: ''
      blockerOwnerText: string
    }

export type TurnHistorySnapshot<T> =
  | { state: 'ready'; rows: T[]; hasLaterRows: boolean }
  | { state: 'unavailable'; rows: []; hasLaterRows: false }

/**
 * Freeze the provider transcript at the immutable owner message linked to this
 * AgentTurn. A delayed turn must never see a newer tab/message and then execute
 * that newer request with the delayed turn's older tool authority.
 */
export function snapshotTurnHistoryRows<T extends { id: string; createdAt: Date }>(
  rows: readonly T[],
  binding: TurnOwnerInputBinding,
): TurnHistorySnapshot<T> {
  if (binding.state === 'unavailable') {
    return { state: 'unavailable', rows: [], hasLaterRows: false }
  }
  if (binding.state === 'absent') {
    return { state: 'ready', rows: [...rows], hasLaterRows: false }
  }

  const ownerRow = rows.find((row) => row.id === binding.messageId)
  const ownerTimestamp = binding.createdAt.getTime()
  if (!ownerRow || ownerRow.createdAt.getTime() !== ownerTimestamp) {
    return { state: 'unavailable', rows: [], hasLaterRows: false }
  }
  // createdAt is millisecond precision while IDs are random UUIDs. A UUID
  // secondary sort cannot establish causality for two rows in the same ms, so
  // retain only the exact bound row from that timestamp and fail closed on all
  // peers instead of risking a newer cross-tab message in the transcript.
  const snapshotRows = rows.filter((row) => (
    row.id === binding.messageId || row.createdAt.getTime() < ownerTimestamp
  ))
  return {
    state: 'ready',
    rows: snapshotRows,
    hasLaterRows: snapshotRows.length < rows.length,
  }
}

function askCardIdFromContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  const ref = (content as Array<{ type?: unknown; askCardId?: unknown }>).find(
    (block) => block?.type === 'ask_card_ref' && typeof block.askCardId === 'string',
  )
  const value = typeof ref?.askCardId === 'string' ? ref.askCardId.trim() : ''
  return value || null
}

/**
 * Resolve a turn to its immutable owner message link. A present turn id that is
 * missing/mismatched/unreadable is `unavailable`, never "use the newest row".
 */
export async function loadTurnOwnerInputBinding(
  conversationId: string,
  turnId: string | null | undefined,
): Promise<TurnOwnerInputBinding> {
  const normalizedConversationId = conversationId.trim()
  const normalizedTurnId = turnId?.trim() ?? ''
  if (!normalizedTurnId) return { state: 'absent' }
  if (!normalizedConversationId) return { state: 'unavailable' }

  try {
    const turn = await prisma.agentTurn.findFirst({
      where: { id: normalizedTurnId, conversationId: normalizedConversationId },
      select: { userMessageId: true },
    })
    const messageId = typeof turn?.userMessageId === 'string' ? turn.userMessageId.trim() : ''
    if (!messageId) return { state: 'unavailable' }

    const message = await prisma.agentMessage.findFirst({
      where: {
        id: messageId,
        conversationId: normalizedConversationId,
        role: 'user',
      },
      select: { id: true, createdAt: true, content: true },
    })
    if (!message) return { state: 'unavailable' }
    const text = messageContentToText(message.content).trim()
    if (!text) return { state: 'unavailable' }

    return {
      state: 'bound',
      messageId: message.id,
      createdAt: message.createdAt,
      text,
      askCardId: askCardIdFromContent(message.content),
    }
  } catch {
    return { state: 'unavailable' }
  }
}

/**
 * Final executor fence for overlapping tabs/requests. Once a newer AgentTurn is
 * accepted, an older turn may no longer perform effects—even if the older model
 * selected its tools before the newer message existed. Equal-millisecond peers
 * are ambiguous and therefore fail closed just like message snapshots.
 */
export async function isTurnOwnerExecutionCurrent(
  conversationId: string | null | undefined,
  turnId: string | null | undefined,
  // Transaction clients deliberately expose only model delegates. Keeping the
  // minimal client structural avoids coupling this fence to Prisma's full root.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any = prisma,
): Promise<boolean> {
  const normalizedConversationId = conversationId?.trim() ?? ''
  const normalizedTurnId = turnId?.trim() ?? ''
  if (!normalizedConversationId || !normalizedTurnId) return false
  try {
    const current = await client.agentTurn.findFirst({
      where: { id: normalizedTurnId, conversationId: normalizedConversationId },
      select: {
        status: true,
        cancelRequested: true,
        startedAt: true,
        userMessageId: true,
      },
    })
    if (!current || current.status !== 'running' || current.cancelRequested) return false
    if (typeof current.userMessageId === 'string' && current.userMessageId.trim()) {
      const ownerMessage = await client.agentMessage.findFirst({
        where: {
          id: current.userMessageId,
          conversationId: normalizedConversationId,
          role: 'user',
        },
        select: { id: true, createdAt: true },
      })
      if (!ownerMessage) return false
      const laterOwnerRows: Array<{ id: string; usage: unknown }> = await client.agentMessage.findMany({
        where: {
          conversationId: normalizedConversationId,
          role: 'user',
          id: { not: ownerMessage.id },
          createdAt: { gte: ownerMessage.createdAt },
        },
        select: { id: true, usage: true },
      })
      const supersedingOwnerInput = laterOwnerRows.some((row) => {
        const usage = row.usage && typeof row.usage === 'object' && !Array.isArray(row.usage)
          ? row.usage as Record<string, unknown>
          : {}
        // Plan-Driver persists its inline directive as a role=user breadcrumb,
        // but it is unattended owner_policy work—not a fresh owner instruction.
        // Its linked turn is filtered below; ignore the matching generated
        // message here so it cannot revoke a witnessed owner browser turn first.
        if (usage.driverDirective === true) return false
        const steering = usage.steering && typeof usage.steering === 'object' && !Array.isArray(usage.steering)
          ? usage.steering as Record<string, unknown>
          : {}
        return steering.targetTurnId !== normalizedTurnId
      })
      if (supersedingOwnerInput) return false
    }
    const competing = await client.agentTurn.findFirst({
      where: {
        conversationId: normalizedConversationId,
        id: { not: normalizedTurnId },
        startedAt: { gte: current.startedAt },
        // Only another owner-authored turn can supersede the owner's current
        // browser authority. Unattended Plan-Driver/heartbeat work is stamped
        // owner_policy and may start while a witnessed browser turn is waiting
        // on Chrome; treating that background work as a newer owner instruction
        // makes the next receipt-bound ACT spuriously stale.
        OR: [
          { instructionOrigin: null },
          { instructionOrigin: 'owner_direct' },
        ],
      },
      select: { id: true },
    })
    return !competing
  } catch {
    return false
  }
}

/**
 * Authority-chain fence for an exact ask-card answer. The incoming answer may
 * legitimately be newer than the turn that emitted the card, but it must be
 * the *only* owner input/turn after that origin. Otherwise an unrelated newer
 * task could be skipped and the stale card would resurrect the old browser
 * goal under the answer turn's fresh token.
 */
export async function isTurnOwnerContinuationCurrent(
  conversationId: string | null | undefined,
  originTurnId: string | null | undefined,
  answerTurnId: string | null | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any = prisma,
): Promise<boolean> {
  const normalizedConversationId = conversationId?.trim() ?? ''
  const normalizedOriginTurnId = originTurnId?.trim() ?? ''
  const normalizedAnswerTurnId = answerTurnId?.trim() ?? ''
  if (
    !normalizedConversationId
    || !normalizedOriginTurnId
    || !normalizedAnswerTurnId
    || normalizedOriginTurnId === normalizedAnswerTurnId
  ) return false

  try {
    const [origin, answer] = await Promise.all([
      client.agentTurn.findFirst({
        where: { id: normalizedOriginTurnId, conversationId: normalizedConversationId },
        select: { startedAt: true, userMessageId: true },
      }),
      client.agentTurn.findFirst({
        where: { id: normalizedAnswerTurnId, conversationId: normalizedConversationId },
        select: { status: true, cancelRequested: true, startedAt: true, userMessageId: true },
      }),
    ])
    if (
      !origin
      || !answer
      || answer.status !== 'running'
      || answer.cancelRequested
      || !(origin.startedAt instanceof Date)
      || !(answer.startedAt instanceof Date)
      || answer.startedAt.getTime() <= origin.startedAt.getTime()
      || typeof origin.userMessageId !== 'string'
      || typeof answer.userMessageId !== 'string'
    ) return false

    const originMessageId = origin.userMessageId.trim()
    const answerMessageId = answer.userMessageId.trim()
    if (!originMessageId || !answerMessageId || originMessageId === answerMessageId) return false
    const [originMessage, answerMessage] = await Promise.all([
      client.agentMessage.findFirst({
        where: { id: originMessageId, conversationId: normalizedConversationId, role: 'user' },
        select: { createdAt: true },
      }),
      client.agentMessage.findFirst({
        where: { id: answerMessageId, conversationId: normalizedConversationId, role: 'user' },
        select: { createdAt: true },
      }),
    ])
    if (
      !originMessage
      || !answerMessage
      || !(originMessage.createdAt instanceof Date)
      || !(answerMessage.createdAt instanceof Date)
      || answerMessage.createdAt.getTime() <= originMessage.createdAt.getTime()
    ) return false

    const [otherOwnerMessage, otherTurn] = await Promise.all([
      client.agentMessage.findFirst({
        where: {
          conversationId: normalizedConversationId,
          role: 'user',
          id: { notIn: [originMessageId, answerMessageId] },
          createdAt: { gte: originMessage.createdAt },
        },
        select: { id: true },
      }),
      client.agentTurn.findFirst({
        where: {
          conversationId: normalizedConversationId,
          id: { notIn: [normalizedOriginTurnId, normalizedAnswerTurnId] },
          startedAt: { gte: origin.startedAt },
        },
        select: { id: true },
      }),
    ])
    return !otherOwnerMessage && !otherTurn
  } catch {
    return false
  }
}

/**
 * Convert the durable binding into the only text a turn may act on. A turn with
 * an exact link always wins over newer conversation rows. An unbound legacy or
 * internal turn may keep ordinary behavior, but it cannot inherit a browser
 * command/continuation from the conversation tail.
 */
export function turnScopedOwnerInput(
  binding: TurnOwnerInputBinding,
  historyLastUserText: string,
): TurnScopedOwnerInput {
  if (binding.state === 'bound') {
    return {
      state: 'exact',
      authoritativeText: binding.text,
      askCardId: binding.askCardId,
    }
  }
  const historyText = historyLastUserText.trim()
  if (
    binding.state === 'unavailable'
    || isDirectYouTubeBrowserTask(historyText)
    || isDirectBrowserContinuationText(historyText)
  ) {
    return {
      state: 'unavailable',
      authoritativeText: '',
      blockerOwnerText: historyText,
    }
  }
  return { state: 'none', authoritativeText: historyText }
}
