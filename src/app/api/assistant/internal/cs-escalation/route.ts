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

type EscalationAction = {
  type: 'staff_reminder' | 'owner_escalation' | 'owner_critical'
  draftId?: string
  staffChatId?: string
  message: string
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyToken(token)) return Response.json({ error: 'unauthorized' }, { status: 401 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const now = Date.now()
  const actions: EscalationAction[] = []

  const pending = await db.csShadowDraft.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: 50,
  })

  const eyafi = await db.agentStaff.findFirst({
    where: { name: { contains: 'Eyafi', mode: 'insensitive' }, active: true },
    select: { telegramChatId: true },
  })

  for (const draft of pending) {
    const ageMin = (now - new Date(draft.createdAt).getTime()) / 60000
    const stage = draft.escalationStage ?? 'none'
    const preview = String(draft.draftText).slice(0, 120)

    if (ageMin >= 10 && stage === 'none') {
      await db.csShadowDraft.update({
        where: { id: draft.id },
        data: { escalationStage: 'reminded' },
      })
      if (eyafi?.telegramChatId) {
        actions.push({
          type: 'staff_reminder',
          staffChatId: eyafi.telegramChatId,
          draftId: draft.id,
          message: `⏰ CS draft এখনো পাঠানো হয়নি — কাস্টমার অপেক্ষায়\n\n${preview}`,
        })
      }
    } else if (ageMin >= 15 && stage === 'reminded') {
      await db.csShadowDraft.update({
        where: { id: draft.id },
        data: { escalationStage: 'owner' },
      })
      actions.push({
        type: 'owner_escalation',
        draftId: draft.id,
        message: `⚠️ CS draft ১৫ মিনিট — staff action নেই\n\n${preview}`,
      })
    } else if (ageMin >= 25 && stage === 'owner') {
      await db.csShadowDraft.update({
        where: { id: draft.id },
        data: { escalationStage: 'critical' },
      })
      actions.push({
        type: 'owner_critical',
        draftId: draft.id,
        message: `CS draft ২৫ মিনিট — কাস্টমার অপেক্ষায়!\n\n${preview}`,
      })
    }
  }

  // Human handoff conversations without ack
  const handoffs = await db.csConversation.findMany({
    where: { status: 'human', mode: 'human' },
    take: 20,
  })
  for (const conv of handoffs) {
    const ageMin = (now - new Date(conv.updatedAt).getTime()) / 60000
    if (ageMin >= 15 && ageMin < 16) {
      actions.push({
        type: 'owner_escalation',
        message: `🙋 CS handoff এখনো acknowledge হয়নি — conv ${conv.id}`,
      })
    }
  }

  return Response.json({ actions })
}
