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
  return Response.json(await getAgentControls())
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
