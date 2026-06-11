import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const body = await req.json().catch(() => ({}))

  const conversationId = typeof body.conversationId === 'string' ? body.conversationId : null
  if (!conversationId) return Response.json({ error: 'conversationId_required' }, { status: 400 })

  const content = typeof body.content === 'string' ? body.content : null
  if (!content) return Response.json({ error: 'content_required' }, { status: 400 })

  const artifact = await prisma.agentArtifact.create({
    data: {
      conversationId,
      messageId: typeof body.messageId === 'string' ? body.messageId : null,
      type: typeof body.type === 'string' ? body.type : 'markdown',
      title: typeof body.title === 'string' ? body.title.trim() || null : null,
      content,
      version: 1,
    },
    select: { id: true, conversationId: true, messageId: true, type: true, title: true, content: true, version: true, createdAt: true },
  })

  return Response.json(artifact, { status: 201 })
}
