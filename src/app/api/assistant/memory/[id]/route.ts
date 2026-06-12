import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { getToken } from 'next-auth/jwt'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { attachMemoryEmbedding } from '@/agent/lib/agent-memory'

async function auth(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return { err: disabled }
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return { err: Response.json({ error: 'unauthorized' }, { status: 401 }) }
  if (!isSystemOwner(token)) return { err: Response.json({ error: 'forbidden' }, { status: 403 }) }
  return { err: null }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const { err } = await auth(req)
  if (err) return err

  let body: { content?: string; pinned?: boolean; key?: string }
  try { body = await req.json() } catch { return Response.json({ error: 'invalid body' }, { status: 400 }) }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    const existing = await db.agentMemory.findUnique({ where: { id: params.id }, select: { id: true } })
    if (!existing) return Response.json({ error: 'not found' }, { status: 404 })

    const updateData: Record<string, unknown> = {}
    let contentToEmbed: string | null = null
    if (body.content !== undefined) {
      contentToEmbed = body.content
      updateData.content = body.content
    }
    if (body.pinned !== undefined) updateData.pinned = body.pinned
    if (body.key !== undefined) updateData.key = body.key

    const updated = await db.agentMemory.update({
      where: { id: params.id },
      data: updateData,
      select: { id: true, scope: true, key: true, content: true, pinned: true, updatedAt: true },
    })
    if (contentToEmbed) {
      await attachMemoryEmbedding(params.id, contentToEmbed)
    }
    return Response.json(updated)
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const { err } = await auth(req)
  if (err) return err

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    const existing = await db.agentMemory.findUnique({ where: { id: params.id }, select: { id: true } })
    if (!existing) return Response.json({ error: 'not found' }, { status: 404 })

    await db.agentMemory.delete({ where: { id: params.id } })
    return new Response(null, { status: 204 })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
