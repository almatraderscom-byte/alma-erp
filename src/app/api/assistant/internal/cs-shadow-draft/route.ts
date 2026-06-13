import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch { return false }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyToken(token)) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json() as { draftId?: string; action?: string; sentBy?: string }
  const { draftId, action, sentBy } = body
  if (!draftId || !action) return Response.json({ error: 'draftId and action required' }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const draft = await db.csShadowDraft.findUnique({ where: { id: draftId } })
  if (!draft) return Response.json({ error: 'not_found' }, { status: 404 })

  if (action === 'notified') {
    return Response.json({ ok: true })
  }

  if (action === 'send') {
    if (['sent', 'dismissed'].includes(draft.status)) {
      return Response.json({ error: `draft_${draft.status}` }, { status: 409 })
    }

    const conv = await db.csConversation.findUnique({
      where: { id: draft.conversationId },
      select: { lastCustomerMessageAt: true },
    })
    if (conv?.lastCustomerMessageAt) {
      const ageMs = Date.now() - new Date(conv.lastCustomerMessageAt).getTime()
      if (ageMs > 23.5 * 60 * 60 * 1000) {
        return Response.json({
          error: 'meta_24h_expired',
          message: '24-ঘণ্টা পার হয়ে গেছে, Meta নিয়ম অনুযায়ী পাঠানো যাবে না',
        }, { status: 422 })
      }
    }

    return Response.json({
      ok: true,
      pageId: draft.pageId,
      psid: draft.psid,
      draftText: draft.draftText,
      attachments: draft.attachments ?? [],
      sentBy: sentBy ?? 'owner',
    })
  }

  if (action === 'mark_sent') {
    if (draft.status === 'sent') return Response.json({ ok: true })
    await db.csShadowDraft.update({
      where: { id: draftId },
      data: { status: 'sent', sentAt: new Date(), escalationStage: 'none' },
    })
    await db.csConversation.update({
      where: { id: draft.conversationId },
      data: { lastCsReplyAt: new Date() },
    })
    return Response.json({ ok: true })
  }

  if (action === 'dismiss') {
    if (draft.status !== 'pending') return Response.json({ ok: true })
    await db.csShadowDraft.update({
      where: { id: draftId },
      data: { status: 'dismissed', escalationStage: 'none' },
    })
    return Response.json({ ok: true })
  }

  if (action === 'acknowledge') {
    await db.csShadowDraft.update({
      where: { id: draftId },
      data: { acknowledgedAt: new Date(), escalationStage: 'none' },
    })
    return Response.json({ ok: true })
  }

  return Response.json({ error: 'unknown_action' }, { status: 400 })
}
