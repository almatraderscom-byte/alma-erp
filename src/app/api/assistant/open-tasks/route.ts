/**
 * Open-loop task chip — conversation-scoped list of unfinished work, plus the
 * Continue / Cancel actions for chat follow-ups.
 *
 *   GET  ?conversationId=...   → { tasks: [...] }
 *        Combines two kinds the owner asked to see together:
 *          • chat_followup    — agent_open_tasks rows the head recorded
 *          • approval_pending — agent_pending_actions still awaiting a decision
 *        (Approval cards keep their own inline Approve/Reject; here they only
 *         add to the "বাকি কাজ" count and link back via pendingActionId.)
 *
 *   POST { id, action: 'continue' | 'cancel' }  (chat_followup only)
 *        • continue → marks the task running, returns its self-contained resumeNote
 *          so the chat can resume that exact work.
 *        • cancel   → marks it cancelled.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { extractBearerToken, verifyAgentInternalToken } from '@/lib/agent-internal-auth'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { listOpenTasks, getOpenTask, markRunning, resolveOpenTask } from '@/agent/lib/open-task'

export const runtime = 'nodejs'

function isInternalToken(req: NextRequest): boolean {
  return verifyAgentInternalToken(extractBearerToken(req.headers.get('authorization')))
}

async function checkAuth(req: NextRequest): Promise<boolean> {
  if (isInternalToken(req)) return true
  const session = await getServerSession(authOptions)
  return !!(session && isSystemOwner(session))
}

export async function GET(req: NextRequest) {
  const gate = requireAgentEnabled()
  if (gate) return gate
  if (!(await checkAuth(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const conversationId = req.nextUrl.searchParams.get('conversationId')
  const businessId = req.nextUrl.searchParams.get('business_id') || 'ALMA_LIFESTYLE'
  if (!conversationId) return NextResponse.json({ tasks: [] })

  // Chat follow-ups the head recorded (self-reconciling against resolved cards).
  const followups = await listOpenTasks(conversationId, businessId)

  // Approval cards still awaiting a decision for this chat.
  const pending = await prisma.agentPendingAction.findMany({
    where: { conversationId, businessId, status: 'pending' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, summary: true, type: true, createdAt: true },
  })

  const tasks = [
    ...followups
      .filter((t) => t.kind === 'chat_followup')
      .map((t) => ({
        id: t.id,
        kind: 'chat_followup' as const,
        title: t.title,
        note: t.resumeNote,
        ageMinutes: t.ageMinutes,
      })),
    ...pending.map((p) => ({
      id: p.id,
      kind: 'approval_pending' as const,
      title: (p.summary || 'অনুমোদন বাকি').slice(0, 120),
      note: p.summary || '',
      pendingActionId: p.id,
      ageMinutes: Math.max(0, Math.round((Date.now() - p.createdAt.getTime()) / 60000)),
    })),
  ]

  return NextResponse.json({ tasks })
}

export async function POST(req: NextRequest) {
  const gate = requireAgentEnabled()
  if (gate) return gate
  if (!(await checkAuth(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { id?: string; action?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }

  const id = String(body.id ?? '').trim()
  const action = body.action === 'cancel' ? 'cancel' : 'continue'
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const task = await getOpenTask(id)
  if (!task) return NextResponse.json({ error: 'not found' }, { status: 404 })

  if (action === 'cancel') {
    await resolveOpenTask(id, 'cancelled')
    return NextResponse.json({ ok: true, action: 'cancel' })
  }

  // continue → hand back the self-contained note so the chat resumes this work.
  await markRunning(id)
  return NextResponse.json({ ok: true, action: 'continue', resumeNote: task.resumeNote, title: task.title })
}
