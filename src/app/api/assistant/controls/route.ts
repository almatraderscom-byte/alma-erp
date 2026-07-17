import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { getAgentControls, setAgentControls, type AgentControls, type AutonomyMode } from '@/agent/lib/agent-controls'

const AUTONOMY_VALUES: AutonomyMode[] = ['ask', 'notify', 'auto']

export const runtime = 'nodejs'

async function requireOwner(req: NextRequest): Promise<Response | null> {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return null
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const forbidden = await requireOwner(req)
  if (forbidden) return forbidden

  // Phase 57 — staged autonomy ladder view for the control centre.
  const section = req.nextUrl.searchParams.get('section')
  if (section === 'autonomy_rollout') {
    const { listRollouts, STAGE_LABEL_BN, LADDER_STAGES } = await import('@/agent/lib/autonomy-rollout')
    const { inspectServiceConnections } = await import('@/agent/lib/integrations/service-registry')
    const [rollouts, services] = await Promise.all([
      listRollouts(),
      inspectServiceConnections().catch(() => []),
    ])
    return Response.json({ rollouts, services, stageLabels: STAGE_LABEL_BN, stages: LADDER_STAGES })
  }

  // Phase 58 — SLO snapshot for the owner monitor panel.
  if (section === 'slo') {
    const { computeSloSnapshot, checkSloBreaches } = await import('@/agent/lib/autonomy-slo')
    const { outboxHealth } = await import('@/agent/lib/effects/outbox')
    const [snapshot, outbox] = await Promise.all([computeSloSnapshot(), outboxHealth().catch(() => ({ due: 0, leased: 0 }))])
    return Response.json({ effects: { outbox, slo: snapshot, breaches: checkSloBreaches(snapshot) } })
  }

  return Response.json(await getAgentControls())
}

/**
 * Phase 57 — ladder actions. One task class per call, one rung per promotion,
 * explicit owner note required; there is NO promote-everything endpoint.
 */
export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const forbidden = await requireOwner(req)
  if (forbidden) return forbidden

  let body: { action?: string; taskClass?: string; toStage?: string; note?: string; service?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const action = String(body.action ?? '')
  const rollout = await import('@/agent/lib/autonomy-rollout')

  if (action === 'promote') {
    const taskClass = String(body.taskClass ?? '')
    const result = await rollout.promoteTaskClass(taskClass, String(body.note ?? ''))
    return Response.json(result, { status: result.ok ? 200 : 422 })
  }
  if (action === 'demote' || action === 'pause') {
    const taskClass = String(body.taskClass ?? '')
    const toStage = action === 'pause' ? 'off' : (String(body.toStage ?? 'off') as (typeof rollout.LADDER_STAGES)[number])
    if (!rollout.LADDER_STAGES.includes(toStage)) return Response.json({ error: 'bad_stage' }, { status: 400 })
    const demoted = await rollout.demoteTaskClass(taskClass, toStage, String(body.note ?? 'owner action'))
    return Response.json({ ok: true, rollout: demoted })
  }
  if (action === 'service_pause' || action === 'service_resume' || action === 'service_revoke' || action === 'service_delete_data') {
    const reg = await import('@/agent/lib/integrations/service-registry')
    const service = String(body.service ?? '')
    const fn =
      action === 'service_pause' ? reg.pauseService
        : action === 'service_resume' ? reg.resumeService
          : action === 'service_revoke' ? reg.revokeService
            : reg.deleteServiceData
    const ok = await fn(service)
    return Response.json({ ok }, { status: ok ? 200 : 422 })
  }
  if (action === 'clear_quarantine') {
    const { clearQuarantine } = await import('@/agent/lib/security/incident-response')
    const ok = await clearQuarantine(String(body.note ?? 'owner cleared via control centre'))
    return Response.json({ ok }, { status: ok ? 200 : 422 })
  }

  return Response.json({ error: 'unknown_action' }, { status: 400 })
}

export async function PATCH(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const forbidden = await requireOwner(req)
  if (forbidden) return forbidden

  let body: Partial<AgentControls>
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const patch: Partial<AgentControls> = {}
  if (typeof body.paused === 'boolean') patch.paused = body.paused
  if (typeof body.autonomy === 'string' && AUTONOMY_VALUES.includes(body.autonomy)) {
    patch.autonomy = body.autonomy
  }
  if (body.capabilities && typeof body.capabilities === 'object') {
    const caps: Partial<AgentControls['capabilities']> = {}
    const c = body.capabilities as unknown as Record<string, unknown>
    if (typeof c.webResearch === 'boolean') caps.webResearch = c.webResearch
    if (typeof c.socialPosting === 'boolean') caps.socialPosting = c.socialPosting
    if (typeof c.imageVideoGen === 'boolean') caps.imageVideoGen = c.imageVideoGen
    if (Object.keys(caps).length > 0) patch.capabilities = caps as AgentControls['capabilities']
  }

  if (Object.keys(patch).length === 0) {
    return Response.json({ error: 'no_valid_fields' }, { status: 400 })
  }

  return Response.json(await setAgentControls(patch))
}
