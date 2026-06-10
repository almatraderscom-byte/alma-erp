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
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await Promise.resolve(params)

  const artifacts = await prisma.agentArtifact.findMany({
    where: { conversationId: id },
    orderBy: { createdAt: 'asc' },
    select: { id: true, messageId: true, type: true, title: true, content: true, version: true, createdAt: true },
  })

  return Response.json(artifacts)
}
