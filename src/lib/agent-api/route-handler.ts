import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { clientIp } from '@/lib/agent-api/ip-allowlist'
import { logAgentAudit } from '@/lib/agent-api/audit-logger'
import { AGENT_ACTOR } from '@/lib/agent-api/constants'

export { guardAgentRequest } from '@/lib/agent-api/guard'

export function agentActorPayload(extra: Record<string, unknown> = {}) {
  return {
    actor: AGENT_ACTOR,
    actor_user_id: AGENT_ACTOR,
    updated_by: AGENT_ACTOR,
    ...extra,
  }
}

export async function agentWrite<T>(
  req: NextRequest,
  actionType: string,
  resourceId: string | null | undefined,
  payload: Record<string, unknown>,
  execute: () => Promise<T>,
): Promise<T> {
  try {
    const result = await execute()
    await logAgentAudit({
      actionType,
      resourceId,
      payload: { ...payload, result: summarizeResult(result) },
      ipAddress: clientIp(req),
    })
    return result
  } catch (err) {
    await logAgentAudit({
      actionType: `${actionType}.failed`,
      resourceId,
      payload: { ...payload, error: (err as Error).message },
      ipAddress: clientIp(req),
    }).catch(() => undefined)
    throw err
  }
}

function summarizeResult(result: unknown): unknown {
  if (result && typeof result === 'object' && 'id' in (result as object)) {
    return { id: (result as { id: unknown }).id }
  }
  if (result && typeof result === 'object' && 'status' in (result as object)) {
    return { status: (result as { status: unknown }).status }
  }
  return result
}

export function agentErrorResponse(err: unknown, status = 500) {
  const message = err instanceof Error ? err.message : 'Internal error'
  const code = status === 404 ? 404 : status === 400 ? 400 : status === 409 ? 409 : 500
  return NextResponse.json({ error: message }, { status: code })
}
