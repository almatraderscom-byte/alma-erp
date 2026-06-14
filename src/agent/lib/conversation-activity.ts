import { prisma } from '@/lib/prisma'

/** Bump conversation activity — resets summarizedAt so idle summarizer can capture new points later. */
export async function touchConversationActivity(conversationId: string): Promise<void> {
  const now = new Date()
  await prisma.agentConversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: now, summarizedAt: null, updatedAt: now },
  })
}
