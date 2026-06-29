/**
 * POST /api/assistant/office/chat/explain  → { taskId }
 *
 * A staff taps a task they don't understand in the "আজকের কাজ" list. The agent
 * explains THAT one task, once, in simple Bangla, posted straight to the group
 * with NO owner approval (owner decision: clarifying an already-assigned task is
 * risk-free). Staff-only — the owner doesn't own tasks here.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { resolveSessionStaff, explainTaskToStaff } from '@/agent/lib/office-staff'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const staff = await resolveSessionStaff(token.sub)
  if (!staff) return Response.json({ error: 'not_staff' }, { status: 403 })

  let body: { taskId?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const taskId = body.taskId?.trim()
  if (!taskId) return Response.json({ error: 'taskId required' }, { status: 400 })

  const result = await explainTaskToStaff(taskId, staff)
  if (!result.ok) return Response.json({ error: result.error }, { status: result.code })

  return Response.json({ ok: true, question: result.question, answer: result.answer }, { status: 201 })
}
