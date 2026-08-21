import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { AUTO_MODEL_ID } from '@/agent/lib/models/registry'
import { prisma } from '@/lib/prisma'
import {
  MACHINE_CONVERSATION_SOURCES,
  topUnreadConversationIds,
  unreadConversationIds,
} from '@/agent/lib/conversation-unread'

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

export function archivedConversationMode(searchParams: Pick<URLSearchParams, 'get'>): boolean {
  return searchParams.get('archived') === 'true'
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
  // The native Archive browser uses the same authenticated, paginated
  // conversation contract. Active remains the default for every existing
  // caller; `archived=true` only switches the visibility predicate.
  const archivedOnly = archivedConversationMode(req.nextUrl.searchParams)

  let cursorUpdatedAt: Date | undefined
  let cursorId: string | undefined
  let cursorPinned: boolean | undefined
  if (cursor) {
    const parts = cursor.split('_')
    const hasPinnedPrefix = parts[0] === '0' || parts[0] === '1'
    const [ts, id] = hasPinnedPrefix ? [parts[1], parts[2]] : [parts[0], parts[1]]
    if (hasPinnedPrefix) cursorPinned = parts[0] === '1'
    if (ts && id) {
      cursorUpdatedAt = new Date(ts)
      cursorId = id
    }
  }

  const conversations = await prisma.agentConversation.findMany({
    where: {
      archived: archivedOnly,
      ...(cursorUpdatedAt && cursorId
        ? cursorPinned === true
          ? {
              OR: [
                { pinned: false },
                {
                  pinned: true,
                  OR: [
                    { updatedAt: { lt: cursorUpdatedAt } },
                    { AND: [{ updatedAt: cursorUpdatedAt }, { id: { lt: cursorId } }] },
                  ],
                },
              ],
            }
          : {
              ...(cursorPinned === false ? { pinned: false } : {}),
              OR: [
                { updatedAt: { lt: cursorUpdatedAt } },
                { AND: [{ updatedAt: cursorUpdatedAt }, { id: { lt: cursorId } }] },
              ],
            }
        : {}),
    },
    orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    select: {
      id: true,
      title: true,
      projectId: true,
      businessId: true,
      modelId: true,
      effortLevel: true,
      chatMode: true,
      permissionMode: true,
      source: true,
      archived: true,
      pinned: true,
      createdAt: true,
      updatedAt: true,
      lastReadAt: true,
    },
  })

  const hasMore = conversations.length > take
  const rawPage = hasMore ? conversations.slice(0, take) : conversations

  // Unread = the agent wrote after Boss last opened this chat. Resolved for the
  // whole page in one grouped query.
  // The agent's own scheduled runs never count — heartbeat and plan_drive write
  // their engine directive as role 'user', so only the source separates them.
  const ownerChats = rawPage.filter(
    (c) => !(MACHINE_CONVERSATION_SOURCES as readonly string[]).includes(c.source),
  )
  const unread = await unreadConversationIds(
    ownerChats.map((c) => c.id),
    new Map(ownerChats.map((c) => [c.id, c.lastReadAt])),
  ).catch(() => new Set<string>())
  const page = rawPage.map(({ lastReadAt: _lastReadAt, ...c }) => ({ ...c, unread: unread.has(c.id) }))

  // The cursor must keep describing the ORDERED-BY-updatedAt scan, so it is taken
  // before anything is reordered or prepended below.
  const last = page[page.length - 1]
  const nextCursor = hasMore && last
    ? `${last.pinned ? '1' : '0'}_${last.updatedAt.toISOString()}_${last.id}`
    : null

  // First page only: unread chats come to the TOP, and any that paging left below
  // the fold are pulled up. A badge saying "4" while the four cannot be found in
  // the list is worse than no badge (owner-reported 2026-08-17).
  if (!cursor && !archivedOnly) {
    try {
      const unreadIds = await topUnreadConversationIds(20)
      const missing = unreadIds.filter((id) => !page.some((c) => c.id === id))
      const extra = missing.length
        ? await prisma.agentConversation.findMany({
            where: { id: { in: missing } },
            select: {
              id: true, title: true, projectId: true, businessId: true, modelId: true,
              effortLevel: true, chatMode: true, permissionMode: true, source: true, archived: true,
              pinned: true, createdAt: true, updatedAt: true,
            },
          })
        : []
      const byId = new Map([...page, ...extra.map((c) => ({ ...c, unread: true }))].map((c) => [c.id, c]))
      const unreadRows = unreadIds.map((id) => byId.get(id)).filter((c) => c !== undefined)
      const rest = page.filter((c) => !unreadIds.includes(c.id))
      page.length = 0
      page.push(...(unreadRows as typeof page), ...rest)
    } catch {
      // Ordering is a nicety; never let it cost him the list itself.
    }
  }

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
      // New web conversations default to Auto (router picks); owner can pin a model.
      modelId: AUTO_MODEL_ID,
      source: 'web',
    },
    select: { id: true, title: true, projectId: true, modelId: true, createdAt: true, updatedAt: true },
  })

  return Response.json(conversation, { status: 201 })
}
