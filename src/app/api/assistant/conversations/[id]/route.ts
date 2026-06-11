import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await Promise.resolve(params)
  const body = await req.json().catch(() => ({}))

  const data: Record<string, unknown> = {}
  if (typeof body.title === 'string') data.title = body.title.trim() || null
  if (typeof body.archived === 'boolean') data.archived = body.archived
  if (body.projectId !== undefined) data.projectId = body.projectId || null

  const updated = await prisma.agentConversation.update({
    where: { id },
    data,
    select: { id: true, title: true, projectId: true, archived: true, updatedAt: true },
  })

  return Response.json(updated)
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await Promise.resolve(params)

  // Messages + artifacts cascade via FK ON DELETE CASCADE.
  await prisma.agentConversation.delete({ where: { id } })

  return new Response(null, { status: 204 })
}
