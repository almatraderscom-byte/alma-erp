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
  const cursor = req.nextUrl.searchParams.get('cursor')

  let cursorUpdatedAt: Date | undefined
  let cursorId: string | undefined
  if (cursor) {
    const [ts, id] = cursor.split('_')
    if (ts && id) {
      cursorUpdatedAt = new Date(ts)
      cursorId = id
    }
  }

  const conversations = await prisma.agentConversation.findMany({
    where: {
      archived: false,
      ...(cursorUpdatedAt && cursorId
        ? {
            OR: [
              { updatedAt: { lt: cursorUpdatedAt } },
              { AND: [{ updatedAt: cursorUpdatedAt }, { id: { lt: cursorId } }] },
            ],
          }
        : {}),
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    select: {
      id: true,
      title: true,
      projectId: true,
      businessId: true,
      model: true,
      archived: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  const hasMore = conversations.length > take
  const page = hasMore ? conversations.slice(0, take) : conversations
  const last = page[page.length - 1]
  const nextCursor = hasMore && last
    ? `${last.updatedAt.toISOString()}_${last.id}`
    : null

  const paginated = req.nextUrl.searchParams.get('paginated') === 'true'
  if (paginated) {
    return Response.json({ conversations: page, nextCursor, hasMore })
  }

  // Plain array for Telegram / legacy callers
  return Response.json(page)
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
      source: 'web',
    },
    select: { id: true, title: true, projectId: true, model: true, createdAt: true, updatedAt: true },
  })

  return Response.json(conversation, { status: 201 })
}
