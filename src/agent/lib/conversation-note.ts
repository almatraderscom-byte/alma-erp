/**
 * One place to say something to Boss in a conversation without running a turn.
 *
 * Every route that finishes background work already had its own private copy of
 * this (approve, job-result, …), which is exactly why the paths that DIDN'T post
 * a note went unnoticed: there was nothing shared to notice was missing. The
 * silence-breaker in `approval-continuation.ts` is the first caller.
 *
 * A note is a real assistant message with zero cost — it shows in the app poll
 * and the Telegram mirror like any other reply, so the owner cannot be left
 * looking at a job that stopped without a word.
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export async function appendAssistantNote(conversationId: string, text: string): Promise<void> {
  if (!conversationId || !text.trim()) return
  await db.agentMessage.create({
    data: {
      conversationId,
      role: 'assistant',
      content: [{ type: 'text', text }],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    },
  })
  await db.agentConversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  })
}
