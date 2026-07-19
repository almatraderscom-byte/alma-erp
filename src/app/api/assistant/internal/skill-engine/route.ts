/**
 * Skill Engine V2 — internal on/off toggle for the KV switch (`skill_engine_enabled`),
 * so the engine can be enabled without a Vercel env change / redeploy. Worker-only
 * (internal token). GET reads the current state; POST { enabled: boolean } sets it.
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { verifyAgentInternalToken, extractBearerToken } from '@/lib/agent-internal-auth'
import { isSkillEngineEnabled, setSkillEngineEnabled } from '@/agent/lib/skill-engine/enabled'

export const runtime = 'nodejs'

function authed(req: NextRequest): boolean {
  return verifyAgentInternalToken(extractBearerToken(req.headers.get('authorization')))
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!authed(req)) return Response.json({ error: 'unauthorized' }, { status: 401 })
  return Response.json({ enabled: await isSkillEngineEnabled() })
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!authed(req)) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as { enabled?: boolean }
  if (typeof body.enabled !== 'boolean') {
    return Response.json({ error: 'enabled (boolean) required' }, { status: 400 })
  }
  await setSkillEngineEnabled(body.enabled)
  return Response.json({ ok: true, enabled: await isSkillEngineEnabled() })
}
