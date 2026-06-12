import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export async function findOrCreateCsConversation(input: {
  pageId: string
  psid: string
  customerName?: string
  fbConversationId?: string
}) {
  const existing = await db.csConversation.findUnique({
    where: { pageId_psid: { pageId: input.pageId, psid: input.psid } },
  })
  if (existing) {
    if (input.customerName || input.fbConversationId) {
      await db.csConversation.update({
        where: { id: existing.id },
        data: {
          ...(input.customerName ? { customerName: input.customerName } : {}),
          ...(input.fbConversationId ? { fbConversationId: input.fbConversationId } : {}),
          lastMessageAt: new Date(),
        },
      })
    }
    return existing
  }

  return db.csConversation.create({
    data: {
      pageId: input.pageId,
      psid: input.psid,
      customerName: input.customerName ?? null,
      fbConversationId: input.fbConversationId ?? null,
    },
  })
}

export async function appendCsMessage(
  conversationId: string,
  role: 'user' | 'assistant' | 'system',
  content: unknown[],
  metaMessageId?: string,
) {
  const msg = await db.csMessage.create({
    data: {
      conversationId,
      role,
      content,
      metaMessageId: metaMessageId ?? null,
    },
  })
  const now = new Date()
  await db.csConversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: now,
      updatedAt: now,
      ...(role === 'user' ? { lastCustomerMessageAt: now } : {}),
    },
  })
  return msg
}

export async function loadCsHistory(conversationId: string, limit = 30) {
  const rows = await db.csMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })
  return rows as Array<{ role: string; content: unknown }>
}

export async function isCsHandledFbConversation(fbConversationId: string): Promise<boolean> {
  const conv = await db.csConversation.findFirst({
    where: { fbConversationId },
    select: { lastCsReplyAt: true, status: true },
  })
  if (!conv?.lastCsReplyAt) return false
  const ageMs = Date.now() - new Date(conv.lastCsReplyAt).getTime()
  return ageMs < 2 * 60 * 60 * 1000
}
