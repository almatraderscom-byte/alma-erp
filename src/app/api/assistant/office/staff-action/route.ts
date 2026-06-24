/**
 * POST /api/assistant/office/staff-action
 * Logged-in staff actions from the in-app office.
 *
 * Actions: done | proof | comment | update | self_create
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import {
  resolveSessionStaff,
  staffMarkDone,
  staffSubmitProof,
  staffComment,
  staffUpdate,
  staffCreateSelfInitiated,
  type StaffResult,
} from '@/agent/lib/office-staff'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function reply(result: StaffResult) {
  if (result.ok) {
    return Response.json({
      ok: true,
      status: result.status,
      needsProof: result.needsProof ?? false,
      proofMessage: result.proofMessage,
    })
  }
  return Response.json({ error: result.error }, { status: result.code })
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const staff = await resolveSessionStaff(token.sub)
  if (!staff) return Response.json({ error: 'not_staff' }, { status: 403 })

  let body: {
    action?: string
    taskId?: string
    body?: string
    text?: string
    imageUrl?: string
    title?: string
    detail?: string
    type?: string
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const action = body.action?.trim()
  if (!action) return Response.json({ error: 'action required' }, { status: 400 })

  if (action === 'self_create') {
    return reply(await staffCreateSelfInitiated(staff, { title: body.title ?? '', detail: body.detail, type: body.type }))
  }

  const taskId = body.taskId?.trim()
  if (!taskId) return Response.json({ error: 'taskId required' }, { status: 400 })

  switch (action) {
    case 'done':
      return reply(await staffMarkDone(taskId, staff))
    case 'proof':
      return reply(await staffSubmitProof(taskId, staff, { imageUrl: body.imageUrl, text: body.text }))
    case 'comment':
      return reply(await staffComment(taskId, staff, body.body ?? ''))
    case 'update':
      return reply(await staffUpdate(taskId, staff, body.body ?? ''))
    default:
      return Response.json({ error: 'unknown_action' }, { status: 400 })
  }
}
