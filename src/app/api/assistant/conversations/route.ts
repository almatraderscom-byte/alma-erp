import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

function verifyInternalToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch { return false }
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  // Accept internal token (worker / Telegram bot) or NextAuth session (web UI)
  const authHeader = req.headers.get('authorization') ?? ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const isInternal = verifyInternalToken(bearerToken)

  if (!isInternal) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  const limitParam = req.nextUrl.searchParams.get('limit')
  const take = limitParam ? Math.min(parseInt(limitParam, 10) || 50, 50) : 50

  const conversations = await prisma.agentConversation.findMany({
    where: { archived: false },
    orderBy: { updatedAt: 'desc' },
    take,
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

  // Return plain array to preserve web UI compatibility.
  // Telegram bot and internal callers also accept this format.
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
