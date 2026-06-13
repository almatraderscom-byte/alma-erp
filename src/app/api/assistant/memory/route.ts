import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { getToken } from 'next-auth/jwt'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { createOrUpdateAgentMemory } from '@/agent/lib/agent-memory'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const { searchParams } = new URL(req.url)
  const scope = searchParams.get('scope') ?? undefined
  const pinned = searchParams.get('pinned')

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).agentMemory.findMany({
      where: {
        ...(scope ? { scope } : {}),
        ...(pinned === 'true' ? { pinned: true } : pinned === 'false' ? { pinned: false } : {}),
      },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, scope: true, key: true, content: true, pinned: true, createdAt: true, updatedAt: true },
    })
    console.log('[assistant/memory GET]', { scope: scope ?? 'all', pinned: pinned ?? 'any', count: rows.length })
    return Response.json(rows)
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: { scope?: string; key?: string; content?: string; pinned?: boolean }
  try { body = await req.json() } catch { return Response.json({ error: 'invalid body' }, { status: 400 }) }

  const { scope, key, content, pinned = false } = body
  if (!scope || !content?.trim()) {
    return Response.json({ error: 'scope and content are required' }, { status: 400 })
  }

  try {
    const mem = await createOrUpdateAgentMemory({
      scope,
      key: key ?? null,
      content,
      pinned,
    })
    return Response.json({
      id: mem.id,
      scope: mem.scope,
      key: mem.key,
      content: mem.content,
      pinned: mem.pinned,
      createdAt: mem.createdAt,
      embedded: mem.embedStatus.embedded,
    }, { status: 201 })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
