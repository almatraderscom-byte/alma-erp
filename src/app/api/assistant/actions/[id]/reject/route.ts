import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const actionId = params.id
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  const action = await db.agentPendingAction.findUnique({ where: { id: actionId } })
  if (!action) return Response.json({ error: 'not_found' }, { status: 404 })
  if (action.status !== 'pending') {
    return Response.json({ error: 'already_resolved', status: action.status }, { status: 409 })
  }

  await db.agentPendingAction.update({
    where: { id: actionId },
    data: { status: 'rejected', resolvedAt: new Date() },
  })

  // Append rejection note to conversation
  const payload = action.payload as Record<string, unknown>
  if (payload.conversationId) {
    await db.agentMessage.create({
      data: {
        conversationId: String(payload.conversationId),
        role: 'assistant',
        content: [{ type: 'text', text: 'Action rejected by owner.' }],
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      },
    })
    await prisma.agentConversation.update({
      where: { id: String(payload.conversationId) },
      data: { updatedAt: new Date() },
    })
  }

  return Response.json({ success: true, status: 'rejected' })
}
