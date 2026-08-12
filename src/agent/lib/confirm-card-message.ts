/**
 * Persist confirm cards in conversation history so they survive reload and polling.
 */
import { prisma } from '@/lib/prisma'
import { decodeUnicodeEscapes } from '@/agent/lib/decode-unicode-escapes'

export type ConfirmCardPayload = {
  pendingActionId: string
  summary: string
  actionType?: string
  costEstimate?: number
  imageModelSelection?: unknown
  /** Build 103 Issue 2 — v2 render selection, projected beside v1. */
  imageRenderSelection?: unknown
  /** Optional deterministic receipt for API-originated cards/reconciliation. */
  clientRequestId?: string
}

export async function appendConfirmCardMessage(
  conversationId: string,
  card: ConfirmCardPayload,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const data = {
      conversationId,
      role: 'assistant',
      content: [{
        type: 'confirm_card',
        pendingActionId: card.pendingActionId,
        summary: decodeUnicodeEscapes(card.summary),
        actionType: card.actionType ?? null,
        costEstimate: card.costEstimate ?? null,
        ...(card.imageModelSelection && typeof card.imageModelSelection === 'object'
          ? { imageModelSelection: card.imageModelSelection }
          : {}),
        ...(card.imageRenderSelection && typeof card.imageRenderSelection === 'object'
          ? { imageRenderSelection: card.imageRenderSelection }
          : {}),
      }],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      ...(card.clientRequestId ? { clientRequestId: card.clientRequestId } : {}),
    }
  if (card.clientRequestId) {
    await db.agentMessage.upsert({
      where: { clientRequestId: card.clientRequestId },
      update: { content: data.content },
      create: data,
    })
  } else {
    await db.agentMessage.create({ data })
  }
  await prisma.agentConversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  })
}
