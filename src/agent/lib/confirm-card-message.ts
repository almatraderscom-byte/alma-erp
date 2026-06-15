/**
 * Persist confirm cards in conversation history so they survive reload and polling.
 */
import { prisma } from '@/lib/prisma'

export type ConfirmCardPayload = {
  pendingActionId: string
  summary: string
  actionType?: string
  costEstimate?: number
}

export async function appendConfirmCardMessage(
  conversationId: string,
  card: ConfirmCardPayload,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  await db.agentMessage.create({
    data: {
      conversationId,
      role: 'assistant',
      content: [{
        type: 'confirm_card',
        pendingActionId: card.pendingActionId,
        summary: card.summary,
        actionType: card.actionType ?? null,
        costEstimate: card.costEstimate ?? null,
      }],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    },
  })
  await prisma.agentConversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  })
}
