import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!isSystemOwner(token)) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  const conversations = await prisma.agentConversation.findMany({
    where: { archived: false },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    select: {
      id: true,
      title: true,
      projectId: true,
      model: true,
      archived: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  return Response.json(conversations)
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!isSystemOwner(token)) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const title: string | undefined = typeof body.title === 'string' ? body.title : undefined
  const projectId: string | undefined = typeof body.projectId === 'string' ? body.projectId : undefined

  const conversation = await prisma.agentConversation.create({
    data: {
      title: title ?? null,
      projectId: projectId ?? null,
      model: 'claude-sonnet-4-6',
    },
    select: { id: true, title: true, projectId: true, model: true, createdAt: true, updatedAt: true },
  })

  return Response.json(conversation, { status: 201 })
}
