/**
 * GET  /api/assistant/active-conversation — the owner's current web/app session
 *   pointer (the conversation shared across web + native app, NOT Telegram). Used
 *   by the web app on load to resume the same thread instead of starting blank.
 * POST /api/assistant/active-conversation — set the pointer (owner switched to /
 *   created a conversation in the app). Telegram has its own separate daily
 *   session and is intentionally never followed here.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { getOwnerSessionPointer, setOwnerSessionConversation } from '@/agent/lib/owner-session'

export const runtime = 'nodejs'

async function ownerGuard(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return null
}

/** Latest real web/app main chat (no project, not Telegram, not the day-shift). */
async function resolveDefaultMainConversation(): Promise<string | null> {
  const conv = await prisma.agentConversation.findFirst({
    where: {
      archived: false,
      projectId: null,
      source: 'web',
    },
    orderBy: { updatedAt: 'desc' },
    select: { id: true },
  })
  return conv?.id ?? null
}

export async function GET(req: NextRequest) {
  const blocked = await ownerGuard(req)
  if (blocked) return blocked

  const pointer = await getOwnerSessionPointer()
  let conversationId = pointer.conversationId

  // Verify the pointer still resolves to a live conversation; fall back to the
  // most recent main chat (or null → app shows a fresh chat) if it was deleted.
  if (conversationId) {
    const exists = await prisma.agentConversation.findFirst({
      where: { id: conversationId, archived: false },
      select: { id: true },
    })
    if (!exists) conversationId = null
  }
  if (!conversationId) conversationId = await resolveDefaultMainConversation()

  // Return enough metadata for the web app to fully restore conversation state
  // (project/model) on load without a second round-trip.
  let projectId: string | null = null
  let modelId: string | null = null
  if (conversationId) {
    const meta = await prisma.agentConversation.findUnique({
      where: { id: conversationId },
      select: { projectId: true, modelId: true },
    })
    projectId = meta?.projectId ?? null
    modelId = meta?.modelId ?? null
  }

  return NextResponse.json({
    conversationId,
    personalConversationId: pointer.personalConversationId,
    projectId,
    modelId,
  })
}

export async function POST(req: NextRequest) {
  const blocked = await ownerGuard(req)
  if (blocked) return blocked

  let body: { conversationId?: unknown; personalMode?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : ''
  if (!conversationId) {
    return NextResponse.json({ error: 'conversationId required' }, { status: 400 })
  }
  await setOwnerSessionConversation({
    conversationId,
    personalMode: body.personalMode === true,
  })
  return NextResponse.json({ ok: true })
}
