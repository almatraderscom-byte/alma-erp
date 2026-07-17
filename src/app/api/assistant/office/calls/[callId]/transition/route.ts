import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { identifyOfficeCallRequest } from '@/agent/lib/office-call-auth'
import {
  OFFICE_CALL_STATES,
  OFFICE_CALL_TERMINAL_REASONS,
  transitionCanonicalOfficeCall,
  type OfficeCallStateValue,
  type OfficeCallTerminalReasonValue,
} from '@/agent/lib/office-call-domain'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { callId: string } }) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const identity = await identifyOfficeCallRequest(req)
  if (!identity.ok) return Response.json({ error: identity.error }, { status: identity.code })

  let body: { state?: string; reason?: string | null; expectedVersion?: number | null }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!OFFICE_CALL_STATES.includes(body.state as OfficeCallStateValue)) {
    return Response.json({ error: 'invalid_state' }, { status: 400 })
  }
  const reason = body.reason?.toUpperCase() || null
  if (reason && !OFFICE_CALL_TERMINAL_REASONS.includes(reason as OfficeCallTerminalReasonValue)) {
    return Response.json({ error: 'invalid_reason' }, { status: 400 })
  }
  if (body.expectedVersion != null && (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 0)) {
    return Response.json({ error: 'invalid_version' }, { status: 400 })
  }

  const result = await transitionCanonicalOfficeCall({
    callId: params.callId,
    businessId: identity.businessId,
    actorUserId: identity.userId,
    target: body.state as OfficeCallStateValue,
    reason: reason as OfficeCallTerminalReasonValue | null,
    expectedVersion: body.expectedVersion ?? null,
  })
  if (!result.ok) {
    const status = result.error === 'not_found' ? 404 : result.error === 'forbidden' ? 403 : 409
    return Response.json(result, { status })
  }
  return Response.json(result)
}
