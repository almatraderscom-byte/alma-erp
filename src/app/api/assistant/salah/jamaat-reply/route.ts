import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { recordJamaatChoiceDirect } from '@/agent/lib/salah-jamaat'

/**
 * POST /api/assistant/salah/jamaat-reply  { conversationId, answer: 'jamaat' | 'alone' }
 *
 * The two quick-reply buttons under the conscience-nudge question ("জামাতে পড়লেন
 * নাকি একা?"). Saves the answer DETERMINISTICALLY (no head/LLM turn — a free-typed
 * reply was sometimes missed by the model) and persists a warm canned agent reply
 * into the conversation, so the owner sees an instant acknowledgement and it
 * survives reload. The active thread's message poll surfaces the new reply.
 */
export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: { conversationId?: unknown; answer?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 })
  }
  const answer = body.answer === 'jamaat' || body.answer === 'alone' ? body.answer : null
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId : null
  if (!answer) return Response.json({ error: 'invalid_answer' }, { status: 400 })

  const { reply } = await recordJamaatChoiceDirect(answer)

  // Persist the canned acknowledgement as an assistant message so it survives reload
  // (best-effort — the answer is already saved to memory regardless).
  if (conversationId) {
    try {
      const conv = await prisma.agentConversation.findUnique({ where: { id: conversationId }, select: { id: true } })
      if (conv) {
        await prisma.agentMessage.create({
          data: {
            conversationId,
            role: 'assistant',
            content: [{ type: 'text', text: reply }],
            tokensIn: 0,
            tokensOut: 0,
            costUsd: 0,
          },
        })
        await prisma.agentConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } })
      }
    } catch (err) {
      console.warn('[jamaat-reply] persist failed:', err instanceof Error ? err.message : err)
    }
  }

  return Response.json({ ok: true, reply })
}
