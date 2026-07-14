import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/**
 * Owner feedback on an agent reply (Roadmap Phase 1).
 *
 * One tap files a correction linked to the exact conversation/message (and turn,
 * when known) — which joins to AgentTurn.versions and the turn's route/tool spans,
 * so "wrong tool" becomes a traceable incident instead of chat lore. The weekly
 * report aggregates these by kind and by behavior-artifact version.
 */
const FEEDBACK_KINDS = new Set([
  'wrong_tool',
  'lost_progress',
  'unnecessary_navigation',
  'wrong_answer',
  'too_many_questions',
  'good',
])

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const kind = String(body.kind ?? '')
  const conversationId = String(body.conversationId ?? '')
  if (!FEEDBACK_KINDS.has(kind)) return Response.json({ error: 'invalid_kind' }, { status: 400 })
  if (!conversationId) return Response.json({ error: 'missing_conversation' }, { status: 400 })

  const messageId = typeof body.messageId === 'string' && body.messageId ? body.messageId : null
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 2000) : null

  // Resolve the turn server-side: the web client doesn't carry turn ids per
  // message, but the message row's timestamp pins the turn that produced it.
  let turnId: string | null = typeof body.turnId === 'string' && body.turnId ? body.turnId : null
  if (!turnId && messageId) {
    try {
      const msg = await db.agentMessage.findUnique({
        where: { id: messageId },
        select: { createdAt: true, conversationId: true },
      })
      if (msg && msg.conversationId === conversationId) {
        const turn = await db.agentTurn.findFirst({
          where: { conversationId, startedAt: { lte: msg.createdAt } },
          orderBy: { startedAt: 'desc' },
          select: { id: true },
        })
        turnId = turn?.id ?? null
      }
    } catch {
      // best-effort — feedback saves without the turn link
    }
  }

  const conv = await db.agentConversation.findUnique({
    where: { id: conversationId },
    select: { businessId: true },
  })

  const row = await db.agentOwnerFeedback.create({
    data: {
      kind,
      conversationId,
      turnId,
      messageId,
      note,
      businessId: conv?.businessId ?? 'ALMA_LIFESTYLE',
    },
    select: { id: true, kind: true, turnId: true },
  })

  return Response.json({ ok: true, feedback: row })
}
