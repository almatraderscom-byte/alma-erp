// CS4: ভালো/বাদ on a gallery item → deterministic scene-pool weighting.
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { bumpSceneWeight } from '@/lib/creative-studio/taste'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: { pendingActionId?: string; verdict?: string }
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }
  const verdict = body.verdict === 'good' ? 'good' : body.verdict === 'bad' ? 'bad' : null
  if (!body.pendingActionId || !verdict) return Response.json({ error: 'invalid_input' }, { status: 422 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const row = await db.agentPendingAction.findUnique({ where: { id: body.pendingActionId } })
  if (!row) return Response.json({ error: 'not_found' }, { status: 404 })
  const payload = (row.payload ?? {}) as { scene?: { id?: string } }
  const sceneId = payload.scene?.id
  if (!sceneId) {
    // item without a scene (e.g. plain edit) — feedback recorded nowhere, be honest
    return Response.json({ ok: true, weighted: false })
  }
  const weight = await bumpSceneWeight(sceneId, verdict)
  return Response.json({ ok: true, weighted: true, sceneId, weight })
}
