import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!isSystemOwner(token)) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await Promise.resolve(params)

  const conversation = await prisma.agentConversation.findUnique({
    where: { id },
    select: { id: true },
  })
  if (!conversation) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  const messages = await prisma.agentMessage.findMany({
    where: { conversationId: id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      role: true,
      content: true,
      tokensIn: true,
      tokensOut: true,
      costUsd: true,
      usage: true,
      createdAt: true,
    },
  })

  // Surface cache tokens (hidden inside the usage JSON) so the UI can show the
  // real per-message token count, not just the tiny non-cached input_tokens.
  const withCache = messages.map((m) => {
    const u = (m.usage ?? {}) as Record<string, unknown>
    const num = (v: unknown) => (typeof v === 'number' ? v : null)
    return {
      ...m,
      cacheCreation: num(u.cache_creation_input_tokens),
      cacheRead: num(u.cache_read_input_tokens),
    }
  })

  return Response.json(withCache)
}
