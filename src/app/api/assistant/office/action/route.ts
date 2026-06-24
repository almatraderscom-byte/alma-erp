/**
 * POST /api/assistant/office/action
 * Owner-only office actions from the in-app Owner Hub.
 *
 * Actions: approve | redo | comment | request_update | self_approve | self_reject
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import {
  approveTask,
  redoTask,
  addComment,
  requestUpdate,
  decideSelfInitiated,
  setTaskDue,
  setAlwaysEscalate,
  type ActionResult,
} from '@/agent/lib/office-actions'
import { decideProposal } from '@/agent/lib/office-proposals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_BUSINESS = 'ALMA_LIFESTYLE'

async function requireOwner(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return { denied: disabled, token: null }
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return { denied: Response.json({ error: 'unauthorized' }, { status: 401 }), token: null }
  if (!isSystemOwner(token)) return { denied: Response.json({ error: 'forbidden' }, { status: 403 }), token: null }
  return { denied: null, token }
}

function reply(result: ActionResult) {
  if (result.ok) return Response.json({ ok: true, status: result.status })
  return Response.json({ error: result.error }, { status: result.code })
}

export async function POST(req: NextRequest) {
  const { denied, token } = await requireOwner(req)
  if (denied) return denied

  let body: {
    action?: string
    taskId?: string
    proposalId?: string
    decision?: string
    note?: string
    body?: string
    businessId?: string
    dueAt?: string | null
    on?: boolean
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const action = body.action?.trim()
  const businessId = body.businessId?.trim() || DEFAULT_BUSINESS
  if (!action) {
    return Response.json({ error: 'action required' }, { status: 400 })
  }

  // Proposal decisions act on a proposalId (penalty/reward), not a taskId.
  if (action === 'proposal_decide') {
    const proposalId = body.proposalId?.trim()
    const decision = body.decision === 'approve' ? 'approve' : body.decision === 'dismiss' ? 'dismiss' : null
    if (!proposalId || !decision) {
      return Response.json({ error: 'proposalId and decision (approve|dismiss) required' }, { status: 400 })
    }
    const result = await decideProposal(proposalId, businessId, decision, token?.sub ?? null)
    if (result.ok) return Response.json({ ok: true })
    return Response.json({ error: result.error }, { status: result.code })
  }

  const taskId = body.taskId?.trim()
  if (!taskId) {
    return Response.json({ error: 'taskId required' }, { status: 400 })
  }

  switch (action) {
    case 'approve':
      return reply(await approveTask(taskId, businessId))
    case 'redo':
      return reply(await redoTask(taskId, businessId, body.note))
    case 'comment':
      return reply(await addComment(taskId, businessId, { body: body.body ?? '', authorUserId: token?.sub ?? null }))
    case 'request_update':
      return reply(await requestUpdate(taskId, businessId, { note: body.note, by: 'owner' }))
    case 'self_approve':
      return reply(await decideSelfInitiated(taskId, businessId, 'approve'))
    case 'self_reject':
      return reply(await decideSelfInitiated(taskId, businessId, 'reject'))
    case 'set_due':
      return reply(await setTaskDue(taskId, businessId, body.dueAt ?? null))
    case 'set_always_escalate':
      return reply(await setAlwaysEscalate(taskId, businessId, body.on === true))
    default:
      return Response.json({ error: 'unknown_action' }, { status: 400 })
  }
}
